import { Data, Effect } from "effect"
import { ContextService } from "./ContextService"
import { FileSystemService } from "./FileSystemService"
import { PhaseService } from "./PhaseService"
import { TaskService } from "./TaskService"
import { WorkbaseService } from "./WorkbaseService"

class PushError extends Data.TaggedError("PushError")<{
	readonly message: string
}> {}

interface CommandResult {
	readonly exitCode: number
	readonly stdout: string
	readonly stderr: string
}

interface CommitMetadata {
	readonly commitId: string
	readonly changeId?: string
	readonly description: string
	readonly empty: boolean
	readonly authorName: string
	readonly authorEmail: string
	readonly conflict: boolean
	readonly parents: readonly string[]
}

interface PushResult {
	readonly vcs: "git" | "jj"
	readonly taskId: string
	readonly phaseId?: string
	readonly branch: string
	readonly base: string
	readonly remote: string
	readonly tip: string
	readonly changeId?: string
}

type PushStage = "context" | "fetch" | "inspect" | "validate" | "publish"

interface PushOptions {
	readonly onProgress?: (stage: PushStage) => void
}

const validEmail = (email: string) => /^[^@\s]+@[^@\s]+$/.test(email)

const requireCommand = (
	fs: FileSystemService,
	args: readonly string[],
	cwd: string,
	label: string,
) =>
	fs.runCommand(args, { cwd, captureOutput: true }).pipe(
		Effect.flatMap((result) =>
			result.exitCode === 0
				? Effect.succeed(result)
				: Effect.fail(
						new PushError({
							message: `${label}: ${result.stderr.trim() || result.stdout.trim()}`,
						}),
					),
		),
	)

const git = (
	fs: FileSystemService,
	cwd: string,
	args: readonly string[],
	label: string,
) => requireCommand(fs, ["git", ...args], cwd, label)

const gitRevision = (fs: FileSystemService, cwd: string, revision: string) =>
	fs
		.runCommand(["git", "rev-parse", "--verify", `${revision}^{commit}`], {
			cwd,
			captureOutput: true,
		})
		.pipe(
			Effect.map((result) =>
				result.exitCode === 0 ? result.stdout.trim() || null : null,
			),
		)

const gitAncestor = (
	fs: FileSystemService,
	cwd: string,
	ancestor: string,
	descendant: string,
) =>
	fs
		.runCommand(["git", "merge-base", "--is-ancestor", ancestor, descendant], {
			cwd,
			captureOutput: true,
		})
		.pipe(
			Effect.flatMap((result) => {
				if (result.exitCode === 0) return Effect.succeed(true)
				if (result.exitCode === 1) return Effect.succeed(false)
				return Effect.fail(
					new PushError({
						message: `Failed to inspect Git ancestry: ${result.stderr.trim()}`,
					}),
				)
			}),
		)

const parseGitCommits = (output: string): readonly CommitMetadata[] =>
	output
		.split("\x1e")
		.map((record) => record.replace(/^\n+|\n+$/g, ""))
		.filter(Boolean)
		.map((record) => {
			const [
				commitId = "",
				authorName = "",
				authorEmail = "",
				description = "",
			] = record.split("\0")
			return {
				commitId,
				description,
				empty: false,
				authorName,
				authorEmail,
				conflict: false,
				parents: [],
			}
		})

const validateGitCommits = (
	commits: readonly CommitMetadata[],
	base: string,
) => {
	if (commits.length === 0) {
		throw new PushError({
			message: `No commits to publish after base '${base}'`,
		})
	}
	const issues: string[] = []
	for (const commit of commits) {
		if (!commit.description.trim()) {
			issues.push(
				`Commit ${commit.commitId} has an empty message. Run: git rebase -i ${base}`,
			)
		}
		if (!commit.authorName.trim() || !validEmail(commit.authorEmail.trim())) {
			issues.push(
				`Commit ${commit.commitId} has an invalid author. Run: git rebase -i ${base}`,
			)
		}
	}
	if (issues.length > 0) throw new PushError({ message: issues.join("\n") })
}

const publishGit = (
	fs: FileSystemService,
	checkout: string,
	remote: string,
	branch: string,
	base: string,
	onProgress?: (stage: PushStage) => void,
) =>
	Effect.gen(function* () {
		onProgress?.("inspect")
		const currentBranch = yield* git(
			fs,
			checkout,
			["symbolic-ref", "--quiet", "--short", "HEAD"],
			"Git checkout must be attached to the declared branch",
		)
		if (currentBranch.stdout.trim() !== branch) {
			return yield* new PushError({
				message: `Declared delivery branch '${branch}' does not match checked-out Git branch '${currentBranch.stdout.trim()}'`,
			})
		}
		const status = yield* git(
			fs,
			checkout,
			["status", "--porcelain=v1"],
			"Failed to inspect Git status",
		)
		if (status.stdout.length > 0) {
			return yield* new PushError({
				message:
					"Cannot publish a dirty Git worktree; commit or discard changes first",
			})
		}

		onProgress?.("fetch")
		yield* git(
			fs,
			checkout,
			["fetch", remote, `+refs/heads/*:refs/remotes/${remote}/*`],
			`Failed to fetch remote '${remote}'`,
		)
		const tip = yield* gitRevision(fs, checkout, "HEAD")
		const baseRevision = yield* gitRevision(
			fs,
			checkout,
			`refs/remotes/${remote}/${base}`,
		)
		if (!tip || !baseRevision) {
			return yield* new PushError({
				message: `Declared base '${base}' was not found on remote '${remote}'`,
			})
		}
		if (!(yield* gitAncestor(fs, checkout, baseRevision, tip))) {
			return yield* new PushError({
				message: `Declared base '${base}' (${baseRevision}) is not an ancestor of Git HEAD (${tip})`,
			})
		}

		onProgress?.("validate")
		const log = yield* git(
			fs,
			checkout,
			[
				"log",
				"--format=%H%x00%an%x00%ae%x00%B%x00%x1e",
				`${baseRevision}..${tip}`,
			],
			"Failed to inspect outgoing Git commits",
		)
		yield* Effect.try({
			try: () => validateGitCommits(parseGitCommits(log.stdout), base),
			catch: (cause) => cause as PushError,
		})

		const remoteTip = yield* gitRevision(
			fs,
			checkout,
			`refs/remotes/${remote}/${branch}`,
		)
		if (remoteTip && !(yield* gitAncestor(fs, checkout, remoteTip, tip))) {
			return yield* new PushError({
				message: `Remote branch '${branch}' on '${remote}' is not an ancestor of Git HEAD; refusing a non-fast-forward update`,
			})
		}

		onProgress?.("publish")
		yield* git(
			fs,
			checkout,
			["push", remote, `HEAD:refs/heads/${branch}`],
			`Failed to push declared branch '${branch}'`,
		)
		yield* git(
			fs,
			checkout,
			[
				"config",
				`remote.${remote}.fetch`,
				`+refs/heads/*:refs/remotes/${remote}/*`,
			],
			`Failed to configure remote '${remote}' tracking`,
		)
		yield* git(
			fs,
			checkout,
			[
				"fetch",
				remote,
				`+refs/heads/${branch}:refs/remotes/${remote}/${branch}`,
			],
			`Failed to refresh published branch '${branch}'`,
		)
		yield* git(
			fs,
			checkout,
			["branch", "--set-upstream-to", `${remote}/${branch}`, branch],
			`Failed to establish upstream tracking for branch '${branch}'`,
		)
		return { tip }
	})

const jjTemplate =
	'"{\\"commitId\\":" ++ json(commit_id) ++ ",\\"changeId\\":" ++ json(change_id) ++ ",\\"description\\":" ++ json(description) ++ ",\\"empty\\":" ++ json(empty) ++ ",\\"authorName\\":" ++ json(author.name()) ++ ",\\"authorEmail\\":" ++ json(author.email()) ++ ",\\"conflict\\":" ++ json(conflict) ++ ",\\"parents\\":" ++ json(parents.map(|parent| parent.commit_id())) ++ "}\\n"'

const jjExact = (value: string) =>
	value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')

const jj = (
	fs: FileSystemService,
	cwd: string,
	args: readonly string[],
	label: string,
) => requireCommand(fs, ["jj", "--no-pager", ...args], cwd, label)

const jjCommits = (fs: FileSystemService, cwd: string, revision: string) =>
	jj(
		fs,
		cwd,
		["log", "--no-graph", "-r", revision, "-T", jjTemplate],
		"Failed to inspect jj changes",
	).pipe(
		Effect.map((result) =>
			result.stdout
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as CommitMetadata),
		),
	)

const jjRevision = (fs: FileSystemService, cwd: string, revision: string) =>
	jjCommits(fs, cwd, revision).pipe(
		Effect.map((commits) => {
			if (commits.length === 0) return null
			if (commits.length === 1) return commits[0]!
			throw new PushError({
				message: `Revision '${revision}' resolves to multiple jj commits`,
			})
		}),
	)

const optionalJjRevision = (
	fs: FileSystemService,
	cwd: string,
	revision: string,
) =>
	jjCommits(fs, cwd, revision).pipe(
		Effect.catchTag("PushError", () => Effect.succeed([])),
		Effect.map((commits) => {
			if (commits.length === 0) return null
			if (commits.length === 1) return commits[0]!
			throw new PushError({
				message: `Bookmark '${revision}' is conflicted or resolves to multiple commits`,
			})
		}),
	)

const jjAncestor = (
	fs: FileSystemService,
	cwd: string,
	ancestor: string,
	descendant: string,
) =>
	jjCommits(fs, cwd, `${ancestor} & ::${descendant}`).pipe(
		Effect.map((commits) => commits.length === 1),
	)

const validateJjCommits = (
	commits: readonly CommitMetadata[],
	base: string,
) => {
	if (commits.length === 0) {
		throw new PushError({
			message: `No changes to publish after base '${base}'`,
		})
	}
	const issues: string[] = []
	for (const commit of commits) {
		const id = commit.changeId!
		if (commit.conflict) {
			issues.push(`Change ${id} contains conflicts. Run: jj resolve -r ${id}`)
		}
		if (!commit.description.trim()) {
			issues.push(`Change ${id} has no description. Run: jj describe -r ${id}`)
		}
		if (!commit.authorName.trim() || !validEmail(commit.authorEmail.trim())) {
			issues.push(
				`Change ${id} has an invalid author. Run: jj metaedit -r ${id} --author 'Name <email>'`,
			)
		}
	}
	if (issues.length > 0) throw new PushError({ message: issues.join("\n") })
}

const publishJj = (
	fs: FileSystemService,
	checkout: string,
	remote: string,
	branch: string,
	base: string,
	onProgress?: (stage: PushStage) => void,
) =>
	Effect.gen(function* () {
		onProgress?.("fetch")
		yield* jj(
			fs,
			checkout,
			["git", "fetch", "--remote", remote],
			`Failed to fetch remote '${remote}'`,
		)
		onProgress?.("inspect")
		const workingCopy = yield* jjRevision(fs, checkout, "@")
		if (!workingCopy) {
			return yield* new PushError({
				message: "jj working copy commit was not found",
			})
		}
		const canonicalPostCommit =
			workingCopy.empty &&
			!workingCopy.description.trim() &&
			workingCopy.parents.length === 1
		const tip = canonicalPostCommit
			? yield* jjRevision(fs, checkout, "@-")
			: workingCopy
		if (!tip) {
			return yield* new PushError({
				message: "jj publication tip was not found",
			})
		}

		const baseBookmark = `${base}@${remote}`
		const baseRevision = yield* optionalJjRevision(
			fs,
			checkout,
			`remote_bookmarks(exact:"${jjExact(base)}", exact:"${jjExact(remote)}")`,
		)
		if (!baseRevision) {
			return yield* new PushError({
				message: `Declared base '${base}' was not found on remote '${remote}'`,
			})
		}
		if (
			!(yield* jjAncestor(fs, checkout, baseRevision.commitId, tip.commitId))
		) {
			return yield* new PushError({
				message: `Declared base '${base}' (${baseRevision.commitId}) is not an ancestor of jj tip ${tip.changeId} (${tip.commitId}). Rebase the stack with: jj rebase -s 'roots(${baseBookmark}..@)' -d ${baseBookmark}`,
			})
		}

		onProgress?.("validate")
		const outgoing = yield* jjCommits(
			fs,
			checkout,
			`${baseRevision.commitId}..${tip.commitId}`,
		)
		yield* Effect.try({
			try: () => validateJjCommits(outgoing, base),
			catch: (cause) => cause as PushError,
		})

		const localBookmark = yield* optionalJjRevision(
			fs,
			checkout,
			`bookmarks(exact:"${jjExact(branch)}")`,
		)
		if (
			localBookmark &&
			!(yield* jjAncestor(fs, checkout, localBookmark.commitId, tip.commitId))
		) {
			return yield* new PushError({
				message: `Local bookmark '${branch}' is not an ancestor of jj tip ${tip.changeId}; refusing to move it`,
			})
		}
		const remoteBookmark = yield* optionalJjRevision(
			fs,
			checkout,
			`remote_bookmarks(exact:"${jjExact(branch)}", exact:"${jjExact(remote)}")`,
		)
		if (
			remoteBookmark &&
			!(yield* jjAncestor(fs, checkout, remoteBookmark.commitId, tip.commitId))
		) {
			return yield* new PushError({
				message: `Remote bookmark '${branch}@${remote}' is not an ancestor of jj tip ${tip.changeId}; refusing a non-fast-forward update`,
			})
		}

		onProgress?.("publish")
		yield* jj(
			fs,
			checkout,
			["bookmark", "set", branch, "-r", tip.commitId],
			`Failed to set declared bookmark '${branch}'`,
		)
		yield* jj(
			fs,
			checkout,
			["git", "push", "--remote", remote, "--bookmark", branch],
			`Failed to push declared bookmark '${branch}'`,
		)
		yield* jj(
			fs,
			checkout,
			["bookmark", "track", `${branch}@${remote}`],
			`Failed to track remote bookmark '${branch}@${remote}'`,
		)
		return { tip: tip.commitId, changeId: tip.changeId }
	})

export class PushService extends Effect.Service<PushService>()("PushService", {
	sync: () => ({
		publish: (startPath: string = process.cwd(), options: PushOptions = {}) =>
			Effect.gen(function* () {
				options.onProgress?.("context")
				const contexts = yield* ContextService
				const fs = yield* FileSystemService
				const tasks = yield* TaskService
				const phases = yield* PhaseService
				const workbase = yield* WorkbaseService
				const context = yield* contexts.get({
					cwd: startPath,
					target: ".",
					compact: true,
				})
				if (!context.validation.valid) {
					return yield* new PushError({
						message: "Cannot publish from an invalid Agency workbase",
					})
				}
				if (context.target.kind !== "task" && context.target.kind !== "phase") {
					return yield* new PushError({
						message: "agency push must run from an execution task or phase",
					})
				}
				if (
					context.authority.mode !== "execution" ||
					!context.authority.writable
				) {
					return yield* new PushError({
						message:
							"Current Agency target has no writable execution authority",
					})
				}
				if (
					!context.workspace?.writable?.materialized ||
					!context.workspace.writable.registered
				) {
					return yield* new PushError({
						message:
							"Current Agency writable checkout is not materialized and registered",
					})
				}
				const blockers = context.graph.readiness.blockers.filter(
					(blocker) =>
						blocker.kind === "dependency" || blocker.kind === "validation",
				)
				if (blockers.length > 0) {
					return yield* new PushError({
						message: `Cannot publish blocked Agency work: ${blockers.map((blocker) => blocker.reason).join("; ")}`,
					})
				}

				const taskId = context.target.taskId
				if (!taskId) {
					return yield* new PushError({
						message: "Current Agency execution target has no task ID",
					})
				}
				const phaseId =
					context.target.kind === "phase" ? context.target.phaseId : undefined
				const task = yield* tasks.show(taskId, context.workbase.root)
				const execution =
					"phases" in task.data
						? phaseId
							? (yield* phases.show(taskId, phaseId, context.workbase.root))
									.data
							: null
						: task.data
				if (!execution || "review" in execution) {
					return yield* new PushError({
						message: "Current Agency target is not a delivery execution unit",
					})
				}
				if (execution.status !== "working") {
					return yield* new PushError({
						message: `Cannot publish Agency work with status '${execution.status}'; status must be working`,
					})
				}
				const checkout = context.authority.writable.checkoutPath
				const { config } = yield* workbase.loadConfig(context.workbase.root)
				const remote = config.delivery?.remote ?? "origin"
				const published =
					context.workbase.vcs === "jj"
						? yield* publishJj(
								fs,
								checkout,
								remote,
								execution.branch,
								execution.base,
								options.onProgress,
							)
						: yield* publishGit(
								fs,
								checkout,
								remote,
								execution.branch,
								execution.base,
								options.onProgress,
							)
				return {
					vcs: context.workbase.vcs,
					taskId,
					...(phaseId ? { phaseId } : {}),
					branch: execution.branch,
					base: execution.base,
					remote,
					...published,
				} satisfies PushResult
			}),
	}),
}) {}
