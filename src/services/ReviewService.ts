import { Data, Effect, Layer } from "effect"
import { randomUUID } from "node:crypto"
import { lstat, mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { FileSystemService } from "./FileSystemService"
import { PhaseService } from "./PhaseService"
import { RepositoryService } from "./RepositoryService"
import { TaskService } from "./TaskService"
import { WorkbaseService } from "./WorkbaseService"
import {
	WorktreeService,
	type WorktreeRemovalSnapshot,
} from "./WorktreeService"
import { withWorktreeLocks } from "./WorktreeLock"
import {
	documentWriteStep,
	runLifecycleTransaction,
	type TransactionStep,
} from "./LifecycleTransaction"
import { RevisionConflictError } from "../workbase/document-revision"
import {
	formatMarkdownDocument,
	parseFrontmatter,
} from "../workbase/frontmatter"
import type { ReviewRecord, ReviewSource } from "../workbase/schemas"

class ReviewError extends Data.TaggedError("ReviewError")<{
	readonly message: string
	readonly cause?: unknown
}> {}

const githubRepository = (remote: string) => {
	const match = remote
		.replace(/\.git\/?$/, "")
		.match(/(?:github\.com[/:])([^/]+\/[^/]+)$/i)
	return match?.[1]?.toLowerCase() ?? null
}

const pinRef = (taskId: string) =>
	`refs/agency/reviews/${Buffer.from(taskId).toString("hex")}`

const runGit = async (args: readonly string[]) => {
	const child = Bun.spawn([...args], { stdout: "pipe", stderr: "pipe" })
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	])
	if (exitCode !== 0) throw new Error(stderr.trim() || args.join(" "))
	return stdout.trim()
}

const WorktreeLayer = Layer.mergeAll(
	FileSystemService.Default,
	WorkbaseService.Default,
	TaskService.Default,
	PhaseService.Default,
	WorktreeService.Default,
)

const runWorktreeEffect = <A, E>(effect: Effect.Effect<A, E, any>) =>
	Effect.runPromise(
		effect.pipe(Effect.provide(WorktreeLayer)) as Effect.Effect<A, E, never>,
	)

const restoreSnapshots = async (
	snapshots: readonly WorktreeRemovalSnapshot[],
) => {
	for (const snapshot of snapshots) {
		try {
			await lstat(snapshot.path)
			continue
		} catch {}
		await mkdir(dirname(snapshot.path), { recursive: true })
		await runGit(
			snapshot.branch
				? [
						"git",
						"-C",
						snapshot.repositoryPath,
						"worktree",
						"add",
						snapshot.path,
						snapshot.branch,
					]
				: [
						"git",
						"-C",
						snapshot.repositoryPath,
						"worktree",
						"add",
						"--detach",
						snapshot.path,
						snapshot.head,
					],
		)
	}
}

const normalizeBranch = (input: string, repositoryPath: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystemService
		if (
			input.startsWith("refs/") &&
			!input.startsWith("refs/heads/") &&
			!input.startsWith("refs/remotes/origin/")
		) {
			return yield* new ReviewError({
				message: `Invalid review branch '${input}'`,
			})
		}
		const name = input
			.replace(/^refs\/remotes\/origin\//, "")
			.replace(/^origin\//, "")
			.replace(/^refs\/heads\//, "")
		if (
			!name ||
			name === "HEAD" ||
			name.startsWith("-") ||
			/[\s:*?\[\\^~]/.test(name) ||
			name.includes("..") ||
			name.includes("@{")
		) {
			return yield* new ReviewError({
				message: `Invalid review branch '${input}'`,
			})
		}
		const checked = yield* fs.runCommand(
			["git", "-C", repositoryPath, "check-ref-format", "--branch", name],
			{ captureOutput: true },
		)
		if (checked.exitCode !== 0) {
			return yield* new ReviewError({
				message: `Invalid review branch '${input}'`,
			})
		}
		return `refs/heads/${name}`
	})

const fetchCommit = (repoPath: string, sourceRef: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystemService
		const temporaryRef = `refs/agency/review-fetch/${process.pid}-${randomUUID()}`
		const fetched = yield* fs.runCommand(
			[
				"git",
				"-C",
				repoPath,
				"fetch",
				"--no-tags",
				"origin",
				`+${sourceRef}:${temporaryRef}`,
			],
			{ captureOutput: true },
		)
		if (fetched.exitCode !== 0) {
			const cleanup = yield* fs.runCommand(
				["git", "-C", repoPath, "update-ref", "-d", temporaryRef],
				{ captureOutput: true },
			)
			return yield* new ReviewError({
				message: `Review source '${sourceRef}' could not be fetched: ${fetched.stderr.trim()}${cleanup.exitCode === 0 ? "" : `; temporary ref cleanup failed: ${cleanup.stderr.trim()}`}`,
			})
		}
		const resolved = yield* fs.runCommand(
			[
				"git",
				"-C",
				repoPath,
				"rev-parse",
				"--verify",
				`${temporaryRef}^{commit}`,
			],
			{ captureOutput: true },
		)
		const cleanup = yield* fs.runCommand(
			["git", "-C", repoPath, "update-ref", "-d", temporaryRef],
			{ captureOutput: true },
		)
		if (cleanup.exitCode !== 0) {
			return yield* new ReviewError({
				message: `Failed to remove temporary review fetch ref: ${cleanup.stderr.trim()}`,
			})
		}
		const commit = resolved.stdout.trim()
		if (resolved.exitCode !== 0 || !/^[a-f0-9]{40}$/.test(commit)) {
			return yield* new ReviewError({
				message: `Review source '${sourceRef}' did not resolve to a commit`,
			})
		}
		return commit
	})

export class ReviewService extends Effect.Service<ReviewService>()(
	"ReviewService",
	{
		sync: () => ({
			resolve: (
				repo: string,
				input: { readonly pullRequest?: string; readonly ref?: string },
				startPath: string = process.cwd(),
			) =>
				Effect.gen(function* () {
					const repositories = yield* RepositoryService
					const repository = yield* repositories.show(repo, startPath)
					if (!repository.remote || repository.states.includes("missing")) {
						return yield* new ReviewError({
							message: `Repository alias '${repo}' must be materialized with an origin remote`,
						})
					}
					let source: ReviewSource
					let sourceRef: string
					if (input.pullRequest) {
						const urlMatch = input.pullRequest.match(
							/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/i,
						)
						const identifier =
							urlMatch?.[2] ??
							(/^\d+$/.test(input.pullRequest) ? input.pullRequest : null)
						if (!identifier) {
							return yield* new ReviewError({
								message: `Invalid GitHub pull request '${input.pullRequest}'`,
							})
						}
						const originRepository = githubRepository(repository.remote)
						if (!originRepository) {
							return yield* new ReviewError({
								message: `Repository alias '${repo}' does not use a GitHub origin`,
							})
						}
						if (urlMatch && urlMatch[1]!.toLowerCase() !== originRepository) {
							return yield* new ReviewError({
								message: `Pull request repository '${urlMatch[1]}' does not match alias '${repo}' origin '${originRepository}'`,
							})
						}
						sourceRef = `refs/pull/${identifier}/head`
						source = {
							kind: "pull-request",
							provider: "github",
							repository: originRepository,
							identifier,
							url: `https://github.com/${originRepository}/pull/${identifier}`,
							fetchRef: sourceRef,
						}
					} else if (input.ref) {
						sourceRef = yield* normalizeBranch(input.ref, repository.path)
						source = { kind: "branch", ref: sourceRef }
					} else {
						return yield* new ReviewError({
							message: "Exactly one review source is required",
						})
					}
					const commit = yield* fetchCommit(repository.path, sourceRef)
					return {
						repo,
						source,
						commit,
						refreshedAt: new Date().toISOString(),
					} satisfies ReviewRecord
				}),

			refresh: (
				taskId: string,
				startPath: string = process.cwd(),
				ifRevision?: string,
			) =>
				Effect.gen(function* () {
					const workbase = yield* WorkbaseService
					const tasks = yield* TaskService
					const worktrees = yield* WorktreeService
					const service = yield* ReviewService
					const repositories = yield* RepositoryService
					const root = yield* workbase.discover(startPath)
					return yield* withWorktreeLocks(
						root,
						[{ taskId }],
						Effect.gen(function* () {
							const task = yield* tasks.show(taskId, root)
							if (!("review" in task.data)) {
								return yield* new ReviewError({
									message: `Task '${taskId}' is not a review task`,
								})
							}
							const previousReview = task.data.review
							if (task.data.claim?.state === "active") {
								return yield* new ReviewError({
									message: `Review task '${taskId}' has an active claim; release or finish it before refreshing`,
								})
							}
							if (ifRevision && task.revision !== ifRevision) {
								return yield* new RevisionConflictError({
									path: task.path,
									target: `task '${taskId}'`,
									expectedRevision: ifRevision,
									currentRevision: task.revision,
									message: `Revision conflict for task '${taskId}'`,
								})
							}
							const inspection = yield* worktrees.inspect(
								taskId,
								undefined,
								root,
							)
							if (
								inspection.conflicts.length ||
								inspection.checkouts.some((checkout) => checkout.dirty)
							) {
								return yield* new ReviewError({
									message: `Cannot refresh review task '${taskId}'; its checkout is dirty or structurally unexpected`,
								})
							}
							const latest = yield* service.resolve(
								task.data.review.repo,
								task.data.review.source.kind === "pull-request"
									? { pullRequest: task.data.review.source.url }
									: { ref: task.data.review.source.ref },
								root,
							)
							const parsed = yield* parseFrontmatter(task.content, task.path)
							const content = formatMarkdownDocument(
								{ ...task.data, review: latest },
								parsed.body,
							)
							const repository = yield* repositories.show(
								task.data.review.repo,
								root,
							)
							const hadCheckout = inspection.checkouts.some(
								(checkout) => checkout.exists || checkout.registered,
							)
							const snapshots: WorktreeRemovalSnapshot[] = []
							const steps: TransactionStep[] = []
							if (hadCheckout) {
								steps.push({
									label: `remove review checkout for ${taskId}`,
									apply: () =>
										runWorktreeEffect(
											worktrees.remove(taskId, undefined, root, {
												snapshots,
												lockHeld: true,
											}),
										).then(() => undefined),
									rollback: () => restoreSnapshots(snapshots),
									manualRecovery: `Restore the detached checkout under ${inspection.codePath}`,
								})
							}
							steps.push(
								documentWriteStep(root, [{ path: task.path, content }]),
							)
							steps.push({
								label: `advance review pin for ${taskId}`,
								apply: () =>
									runGit([
										"git",
										"-C",
										repository.path,
										"update-ref",
										pinRef(taskId),
										latest.commit,
										previousReview.commit,
									]).then(() => undefined),
								rollback: () =>
									runGit([
										"git",
										"-C",
										repository.path,
										"update-ref",
										pinRef(taskId),
										previousReview.commit,
										latest.commit,
									]).then(() => undefined),
								manualRecovery: `Reset ${pinRef(taskId)} to ${previousReview.commit}`,
							})
							if (hadCheckout) {
								steps.push({
									label: `create refreshed review checkout for ${taskId}`,
									apply: () =>
										runWorktreeEffect(
											worktrees.materialize(taskId, undefined, root, {
												lockHeld: true,
											}),
										).then(() => undefined),
									manualRecovery: `Run agency work prepare for review task '${taskId}'`,
								})
							}
							yield* runLifecycleTransaction({
								root,
								preconditions: [{ path: task.path, revision: task.revision }],
								steps,
							})
							return {
								taskId,
								previousCommit: task.data.review.commit,
								commit: latest.commit,
								changed: latest.commit !== task.data.review.commit,
								refreshedAt: latest.refreshedAt,
								revision: (yield* tasks.show(taskId, root)).revision,
							}
						}),
					)
				}),
		}),
	},
) {}
