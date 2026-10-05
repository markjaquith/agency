import { Schema } from "@effect/schema"
import { Data, Effect } from "effect"
import { dirname, join, relative } from "node:path"
import { FileSystemService } from "./FileSystemService"
import { GraphMutationService } from "./GraphMutationService"
import { PhaseService } from "./PhaseService"
import { TaskService } from "./TaskService"
import { isDirtyGitStatus } from "./VersionControlService"
import { WorkbaseService } from "./WorkbaseService"
import { RevisionConflictError } from "../workbase/document-revision"

class RebaseError extends Data.TaggedError("RebaseError")<{
	readonly message: string
	readonly cause?: unknown
}> {}

class RebaseConflictError extends Data.TaggedError("RebaseConflictError")<{
	readonly message: string
	readonly target: string
	readonly checkoutPath: string
	readonly previousBase: string
	readonly base: string
	readonly conflictedPaths: readonly string[]
	readonly continueCommand: string
	readonly abortCommand: string
}> {}

export interface RebaseTarget {
	readonly taskId: string
	readonly phaseId?: string
}

export interface RebaseOptions extends RebaseTarget {
	readonly onto?: string
	readonly from?: string
	readonly dryRun?: boolean
	readonly ifRevision?: string
}

interface CommitSummary {
	readonly commit: string
	readonly subject: string
}

const RebaseState = Schema.Struct({
	version: Schema.Literal(1),
	target: Schema.String,
	previousBase: Schema.String,
	base: Schema.String,
	revision: Schema.String,
	upstream: Schema.String,
	onto: Schema.String,
	previousHead: Schema.String,
})
type RebaseState = Schema.Schema.Type<typeof RebaseState>

const stateFileName = "agency-rebase.json"
const rebaseTimeoutMs = 300_000

const commandFor = (target: RebaseTarget, flag: string) =>
	`agency rebase ${target.taskId}${target.phaseId ? ` ${target.phaseId}` : ""} ${flag}`

const parseCommits = (output: string): CommitSummary[] =>
	output
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [commit = "", ...subject] = line.split("\0")
			return { commit, subject: subject.join("\0") }
		})

const resolveUnit = (target: RebaseTarget, root: string) =>
	Effect.gen(function* () {
		if (target.phaseId) {
			const record = yield* (yield* PhaseService).show(
				target.taskId,
				target.phaseId,
				root,
			)
			return {
				key: `phase:${target.taskId}/${target.phaseId}`,
				label: `Phase '${target.taskId}/${target.phaseId}'`,
				path: record.path,
				revision: record.revision,
				data: record.data,
			}
		}
		const record = yield* (yield* TaskService).show(target.taskId, root)
		if ("review" in record.data)
			return yield* new RebaseError({
				message: `Review task '${target.taskId}' does not have writable execution metadata`,
			})
		if (!("repo" in record.data))
			return yield* new RebaseError({
				message: `Task '${target.taskId}' has multiple phases; rebase a phase instead`,
			})
		return {
			key: `task:${target.taskId}`,
			label: `Task '${target.taskId}'`,
			path: record.path,
			revision: record.revision,
			data: record.data,
		}
	})

const inspectCheckout = (target: RebaseTarget, startPath: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystemService
		const { root, config } = yield* (yield* WorkbaseService).loadConfig(
			startPath,
		)
		const unit = yield* resolveUnit(target, root)
		const checkout = join(dirname(unit.path), "code", unit.data.repo)
		const remote = config.delivery?.remote ?? "origin"
		const fail = (message: string) => new RebaseError({ message })
		const run = (
			args: readonly string[],
			options: { readonly timeoutMs?: number; readonly editor?: boolean } = {},
		) =>
			fs
				.runCommand(["git", ...args], {
					cwd: checkout,
					captureOutput: true,
					timeoutMs: options.timeoutMs ?? 30_000,
					env: {
						GIT_TERMINAL_PROMPT: "0",
						...(options.editor ? { GIT_EDITOR: "true" } : {}),
					},
				})
				.pipe(
					Effect.mapError(
						(cause) =>
							new RebaseError({
								message: `Failed to run git ${args[0]} in ${checkout}`,
								cause,
							}),
					),
				)
		const git = (args: readonly string[]) =>
			run(args).pipe(
				Effect.flatMap((result) =>
					result.exitCode === 0
						? Effect.succeed(result.stdout.trim())
						: Effect.fail(
								fail(
									`git ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`,
								),
							),
				),
			)
		const revision = (ref: string) =>
			run(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).pipe(
				Effect.map((result) =>
					result.exitCode === 0 ? result.stdout.trim() || null : null,
				),
			)
		if (!(yield* fs.isDirectory(checkout)))
			return yield* fail(
				`${unit.label} has no materialized checkout at ${checkout}; prepare it first`,
			)
		const gitDir = yield* git([
			"rev-parse",
			"--path-format=absolute",
			"--git-dir",
		])
		const rebaseInProgress = Effect.gen(function* () {
			for (const marker of ["rebase-merge", "rebase-apply"])
				if (yield* fs.exists(join(gitDir, marker))) return true
			return false
		})
		const otherOperationInProgress = Effect.gen(function* () {
			for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"])
				if (yield* fs.exists(join(gitDir, marker))) return true
			return false
		})
		const statePath = join(gitDir, stateFileName)
		const readState = Effect.gen(function* () {
			if (!(yield* fs.exists(statePath))) return null
			const content = yield* fs.readFile(statePath)
			return yield* Effect.try(() => JSON.parse(content) as unknown).pipe(
				Effect.flatMap(Schema.decodeUnknown(RebaseState)),
				Effect.mapError(
					(cause) =>
						new RebaseError({
							message: `Agency rebase state at ${statePath} is unreadable; inspect or delete it`,
							cause,
						}),
				),
			)
		})
		const writeState = (state: RebaseState) =>
			fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`).pipe(
				Effect.mapError(
					(cause) =>
						new RebaseError({
							message: `Failed to write Agency rebase state at ${statePath}`,
							cause,
						}),
				),
			)
		const clearState = fs
			.deleteFile(statePath)
			.pipe(Effect.catchAll(() => Effect.void))
		const requireBranch = Effect.gen(function* () {
			const head = yield* run(["symbolic-ref", "--quiet", "HEAD"])
			if (
				head.exitCode !== 0 ||
				head.stdout.trim() !== `refs/heads/${unit.data.branch}`
			)
				return yield* fail(
					`Checkout ${checkout} is not on declared branch '${unit.data.branch}'`,
				)
		})
		const requireClean = Effect.gen(function* () {
			const status = yield* git([
				"status",
				"--porcelain=v1",
				"-z",
				"--untracked-files=all",
			])
			if (isDirtyGitStatus(status))
				return yield* fail(
					`Checkout ${checkout} has uncommitted changes; commit or discard them first`,
				)
		})
		const conflictedPaths = git([
			"diff",
			"--name-only",
			"--diff-filter=U",
		]).pipe(
			Effect.map((output) => output.split("\n").filter(Boolean)),
			Effect.catchAll(() => Effect.succeed([] as string[])),
		)
		return {
			root,
			unit,
			checkout,
			remote,
			fail,
			run,
			git,
			revision,
			rebaseInProgress,
			otherOperationInProgress,
			readState,
			writeState,
			clearState,
			requireBranch,
			requireClean,
			conflictedPaths,
		}
	})

type Checkout = Effect.Effect.Success<ReturnType<typeof inspectCheckout>>

const dependentWarnings = (checkout: Checkout) =>
	Effect.gen(function* () {
		const { root, unit } = checkout
		const tasks = yield* TaskService
		const phases = yield* PhaseService
		const dependents: string[] = []
		for (const task of yield* tasks.list(root)) {
			if (
				"repo" in task.data &&
				`task:${task.id}` !== unit.key &&
				task.data.repo === unit.data.repo &&
				task.data.base === unit.data.branch
			)
				dependents.push(`task:${task.id}`)
			if (!("phases" in task.data)) continue
			for (const phase of yield* phases.list(task.id, root)) {
				if (
					`phase:${task.id}/${phase.id}` !== unit.key &&
					phase.data.repo === unit.data.repo &&
					phase.data.base === unit.data.branch
				)
					dependents.push(`phase:${task.id}/${phase.id}`)
			}
		}
		return dependents.map(
			(dependent) =>
				`${dependent} is based on '${unit.data.branch}' and may need its own rebase; dependencies were not changed`,
		)
	})

const publicationWarnings = (checkout: Checkout, base: string) =>
	Effect.gen(function* () {
		const { unit, remote, revision } = checkout
		const warnings: string[] = []
		const published = yield* revision(
			`refs/remotes/${remote}/${unit.data.branch}`,
		)
		if (published || unit.data.pr)
			warnings.push(
				`Rewritten history must be force-pushed: git push --force-with-lease ${remote} ${unit.data.branch} (agency push rejects non-fast-forward publication)`,
			)
		if (unit.data.pr && base !== unit.data.base)
			warnings.push(
				`Pull request ${unit.data.pr} still targets '${unit.data.base}'; change its base to '${base}' (gh pr edit ${unit.data.pr} --base ${base}) before running agency sync, which adopts the pull request base`,
			)
		return warnings
	})

const historyEntry = (state: RebaseState, replayed: number) =>
	`${new Date().toISOString().slice(0, 10)}: base changed from \`${state.previousBase}\` to \`${state.base}\` by \`agency rebase\` (replayed ${replayed} commit${replayed === 1 ? "" : "s"} onto ${state.onto.slice(0, 12)})`

const finish = (
	checkout: Checkout,
	target: RebaseTarget,
	state: RebaseState,
	startPath: string,
) =>
	Effect.gen(function* () {
		const { unit, git, root, clearState } = checkout
		const head = yield* git(["rev-parse", "HEAD"])
		const descends = yield* checkout.run([
			"merge-base",
			"--is-ancestor",
			state.onto,
			head,
		])
		if (descends.exitCode !== 0) {
			yield* clearState
			return yield* checkout.fail(
				`Rebase finished but HEAD ${head} does not descend from ${state.onto}; base metadata was not changed`,
			)
		}
		const replayed = parseCommits(
			yield* git(["log", "--format=%H%x00%s", `${state.onto}..${head}`]),
		).length
		let changedPaths: readonly string[] = []
		if (state.base !== state.previousBase) {
			const recorded = yield* (yield* GraphMutationService)
				.recordRebasedBase(
					target,
					state.base,
					historyEntry(state, replayed),
					state.revision,
					startPath,
				)
				.pipe(
					Effect.catchAll((cause) =>
						clearState.pipe(
							Effect.zipRight(
								Effect.fail(
									new RebaseError({
										message: `Rebase completed but base '${state.base}' could not be recorded${cause instanceof RevisionConflictError ? " because the document changed" : ""}; record it with agency ${target.phaseId ? `phase update ${target.taskId} ${target.phaseId}` : `task update ${target.taskId}`} --base ${state.base}`,
										cause,
									}),
								),
							),
						),
					),
				)
			changedPaths = recorded.changedPaths
		}
		yield* clearState
		return { head, replayed, changedPaths }
	})

const conflict = (
	checkout: Checkout,
	target: RebaseTarget,
	state: RebaseState,
	detail: string,
) =>
	Effect.gen(function* () {
		const paths = yield* checkout.conflictedPaths
		return yield* new RebaseConflictError({
			message: `Rebase of '${checkout.unit.data.branch}' onto '${state.base}' stopped${detail ? `: ${detail}` : ""}. Resolve and stage the conflicts in ${checkout.checkout}, then run ${commandFor(target, "--continue")}, or run ${commandFor(target, "--abort")}. Base metadata is unchanged.`,
			target: checkout.unit.key,
			checkoutPath: checkout.checkout,
			previousBase: state.previousBase,
			base: state.base,
			conflictedPaths: paths,
			continueCommand: commandFor(target, "--continue"),
			abortCommand: commandFor(target, "--abort"),
		})
	})

const fetchBases = (checkout: Checkout, bases: readonly string[]) =>
	Effect.gen(function* () {
		const { run, remote } = checkout
		const listed = yield* run(
			["ls-remote", "--heads", remote, ...bases.map((b) => `refs/heads/${b}`)],
			{ timeoutMs: 60_000 },
		)
		if (listed.exitCode !== 0)
			return [
				`Could not reach remote '${remote}'; using local refs: ${listed.stderr.trim()}`,
			]
		const available = bases.filter((base) =>
			listed.stdout
				.split("\n")
				.some((line) => line.endsWith(`\trefs/heads/${base}`)),
		)
		if (!available.length) return []
		const fetched = yield* run(
			[
				"fetch",
				"--no-tags",
				remote,
				...available.map(
					(base) => `+refs/heads/${base}:refs/remotes/${remote}/${base}`,
				),
			],
			{ timeoutMs: 120_000 },
		)
		return fetched.exitCode === 0
			? []
			: [
					`Could not fetch from remote '${remote}'; using local refs: ${fetched.stderr.trim()}`,
				]
	})

const resolveBase = (checkout: Checkout, base: string) =>
	Effect.gen(function* () {
		for (const ref of [
			`refs/remotes/${checkout.remote}/${base}`,
			`refs/heads/${base}`,
		]) {
			const commit = yield* checkout.revision(ref)
			if (commit) return { ref, commit }
		}
		return null
	})

export class RebaseService extends Effect.Service<RebaseService>()(
	"RebaseService",
	{
		sync: () => ({
			rebase: (options: RebaseOptions, startPath: string = process.cwd()) =>
				Effect.gen(function* () {
					const checkout = yield* inspectCheckout(options, startPath)
					const { unit, fail, git, remote } = checkout
					if (["done", "dropped"].includes(unit.data.status))
						return yield* fail(
							`${unit.label} is ${unit.data.status}; reopen it before rebasing`,
						)
					if (options.ifRevision && options.ifRevision !== unit.revision)
						return yield* new RevisionConflictError({
							path: relative(checkout.root, unit.path),
							target: unit.key,
							expectedRevision: options.ifRevision,
							currentRevision: unit.revision,
							message: `Revision conflict for ${relative(checkout.root, unit.path)}`,
						})
					if (yield* checkout.readState)
						return yield* fail(
							`An Agency rebase is already in progress in ${checkout.checkout}; run ${commandFor(options, "--continue")} or ${commandFor(options, "--abort")}`,
						)
					if (
						(yield* checkout.rebaseInProgress) ||
						(yield* checkout.otherOperationInProgress)
					)
						return yield* fail(
							`A Git operation is already in progress in ${checkout.checkout}; finish or abort it first`,
						)
					yield* checkout.requireBranch
					yield* checkout.requireClean

					const previousBase = unit.data.base
					const base = options.onto ?? previousBase
					const warnings = [
						...(yield* fetchBases(
							checkout,
							base === previousBase ? [base] : [base, previousBase],
						)),
					]
					const onto = yield* resolveBase(checkout, base)
					if (!onto)
						return yield* fail(
							`New base '${base}' does not resolve as '${remote}/${base}' or a local branch`,
						)
					const previousHead = yield* git(["rev-parse", "HEAD"])
					let upstream: { ref: string; commit: string }
					if (options.from) {
						const commit = yield* checkout.revision(options.from)
						if (!commit)
							return yield* fail(
								`--from '${options.from}' does not resolve to a commit`,
							)
						upstream = { ref: options.from, commit }
					} else {
						const old = yield* resolveBase(checkout, previousBase)
						if (!old)
							return yield* fail(
								`Current base '${previousBase}' does not resolve as '${remote}/${previousBase}' or a local branch; pass --from <commit> to name the last commit that should not be replayed`,
							)
						const mergeBase = yield* git([
							"merge-base",
							old.commit,
							previousHead,
						])
						upstream = { ref: old.ref, commit: mergeBase }
					}
					const replayed = parseCommits(
						yield* git([
							"log",
							"--reverse",
							"--format=%H%x00%s",
							`${upstream.commit}..${previousHead}`,
						]),
					)
					const dropped = parseCommits(
						yield* git([
							"log",
							"--format=%H%x00%s",
							upstream.commit,
							"--not",
							onto.commit,
						]),
					)
					warnings.push(
						...(yield* publicationWarnings(checkout, base)),
						...(base !== previousBase
							? yield* dependentWarnings(checkout)
							: []),
					)
					const upToDate = upstream.commit === onto.commit
					const summary = {
						operation: "rebase",
						target: unit.key,
						checkoutPath: checkout.checkout,
						branch: unit.data.branch,
						remote,
						previousBase,
						base,
						onto,
						upstream,
						previousHead,
						replayed,
						dropped,
						warnings,
					}
					if (options.dryRun)
						return {
							...summary,
							dryRun: true,
							status: upToDate ? "up-to-date" : "planned",
							head: previousHead,
							recorded: false,
							changedPaths: [] as readonly string[],
						}

					const state: RebaseState = {
						version: 1,
						target: unit.key,
						previousBase,
						base,
						revision: options.ifRevision ?? unit.revision,
						upstream: upstream.commit,
						onto: onto.commit,
						previousHead,
					}
					if (!upToDate) {
						yield* checkout.writeState(state)
						const rebased = yield* checkout.run(
							["rebase", "--onto", onto.commit, upstream.commit],
							{ timeoutMs: rebaseTimeoutMs, editor: true },
						)
						if (rebased.exitCode !== 0) {
							if (yield* checkout.rebaseInProgress)
								return yield* conflict(
									checkout,
									options,
									state,
									rebased.stderr.trim().split("\n")[0] ?? "",
								)
							yield* checkout.clearState
							return yield* fail(
								`git rebase failed: ${rebased.stderr.trim() || rebased.stdout.trim()}`,
							)
						}
					}
					const finished = yield* finish(checkout, options, state, startPath)
					return {
						...summary,
						dryRun: false,
						status: upToDate ? "up-to-date" : "rebased",
						head: finished.head,
						recorded: finished.changedPaths.length > 0,
						changedPaths: finished.changedPaths,
					}
				}),

			continueRebase: (
				target: RebaseTarget,
				startPath: string = process.cwd(),
			) =>
				Effect.gen(function* () {
					const checkout = yield* inspectCheckout(target, startPath)
					const state = yield* checkout.readState
					if (!state || state.target !== checkout.unit.key)
						return yield* checkout.fail(
							`No Agency rebase is in progress for ${checkout.unit.label}`,
						)
					if (yield* checkout.rebaseInProgress) {
						const continued = yield* checkout.run(["rebase", "--continue"], {
							timeoutMs: rebaseTimeoutMs,
							editor: true,
						})
						if (continued.exitCode !== 0) {
							if (yield* checkout.rebaseInProgress)
								return yield* conflict(
									checkout,
									target,
									state,
									continued.stderr.trim().split("\n")[0] ?? "",
								)
							return yield* checkout.fail(
								`git rebase --continue failed: ${continued.stderr.trim() || continued.stdout.trim()}`,
							)
						}
					}
					yield* checkout.requireBranch
					yield* checkout.requireClean
					const finished = yield* finish(checkout, target, state, startPath)
					return {
						operation: "rebase.continue",
						target: checkout.unit.key,
						checkoutPath: checkout.checkout,
						branch: checkout.unit.data.branch,
						previousBase: state.previousBase,
						base: state.base,
						previousHead: state.previousHead,
						head: finished.head,
						status: "rebased",
						recorded: finished.changedPaths.length > 0,
						changedPaths: finished.changedPaths,
						warnings: [
							...(yield* publicationWarnings(checkout, state.base)),
							...(state.base !== state.previousBase
								? yield* dependentWarnings(checkout)
								: []),
						],
					}
				}),

			abortRebase: (target: RebaseTarget, startPath: string = process.cwd()) =>
				Effect.gen(function* () {
					const checkout = yield* inspectCheckout(target, startPath)
					const state = yield* checkout.readState
					if (!state || state.target !== checkout.unit.key)
						return yield* checkout.fail(
							`No Agency rebase is in progress for ${checkout.unit.label}`,
						)
					if (yield* checkout.rebaseInProgress) {
						const aborted = yield* checkout.run(["rebase", "--abort"])
						if (aborted.exitCode !== 0)
							return yield* checkout.fail(
								`git rebase --abort failed: ${aborted.stderr.trim()}`,
							)
					}
					yield* checkout.clearState
					const head = yield* checkout.git(["rev-parse", "HEAD"])
					return {
						operation: "rebase.abort",
						target: checkout.unit.key,
						checkoutPath: checkout.checkout,
						branch: checkout.unit.data.branch,
						previousBase: state.previousBase,
						base: state.base,
						head,
						status: "aborted",
						recorded: false,
						changedPaths: [] as readonly string[],
						warnings:
							head === state.previousHead
								? []
								: [
										`HEAD ${head} differs from the pre-rebase HEAD ${state.previousHead}; inspect the branch before resetting it`,
									],
					}
				}),
		}),
	},
) {}
