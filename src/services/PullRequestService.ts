import { Data, Effect } from "effect"
import { FileSystemService } from "./FileSystemService"
import { WorkbaseService } from "./WorkbaseService"
import { WorktreeService } from "./WorktreeService"
import type { BaseCommandOptions } from "../utils/command"
import { TaskService } from "./TaskService"
import { PhaseService } from "./PhaseService"
import { ReadinessService } from "./ReadinessService"
import {
	formatMarkdownDocument,
	parseFrontmatter,
} from "../workbase/frontmatter"
import type { PullRequestRecord } from "../workbase/schemas"
import {
	normalizePullRequestRecord,
	parsePullRequestRecord,
	recordFromGitHubUrl,
	resolveDeliveryCommand,
} from "../workbase/delivery-command"

class PullRequestError extends Data.TaggedError("PullRequestError")<{
	readonly message: string
}> {}

const repositoryFromRemote = (remote: string) =>
	remote
		.replace(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?[^/]+\//i, "")
		.replace(/^[^:]+:/, "")
		.replace(/\.git\/?$/, "")
		.replace(/\/$/, "")

interface PullRequestOptions extends BaseCommandOptions {
	readonly force?: boolean
}

export class PullRequestService extends Effect.Service<PullRequestService>()(
	"PullRequestService",
	{
		sync: () => ({
			setRecord: (
				taskId: string,
				phaseId: string | undefined,
				record: PullRequestRecord,
				startPath: string = process.cwd(),
			) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const workbase = yield* WorkbaseService
					const tasks = yield* TaskService
					const phases = yield* PhaseService
					const root = yield* workbase.discover(startPath)
					const task = yield* tasks.show(taskId, root)
					if ("review" in task.data) {
						return yield* new PullRequestError({
							message: `Review task '${taskId}' cannot record a delivery pull request`,
						})
					}
					const target =
						"phases" in task.data
							? phaseId
								? yield* phases.show(taskId, phaseId, root)
								: yield* new PullRequestError({
										message: `Task '${taskId}' requires a phase ID`,
									})
							: task
					const parsed = yield* parseFrontmatter(target.content, target.path)
					yield* fs.writeFile(
						target.path,
						formatMarkdownDocument({ ...target.data, pr: record }, parsed.body),
					)
					return record.url
				}),

			setUrl: (
				taskId: string,
				phaseId: string | undefined,
				url: string,
				startPath: string = process.cwd(),
			) =>
				Effect.gen(function* () {
					const service = yield* PullRequestService
					const record = yield* Effect.try({
						try: () => recordFromGitHubUrl(url),
						catch: (cause) =>
							new PullRequestError({
								message: cause instanceof Error ? cause.message : String(cause),
							}),
					})
					return yield* service.setRecord(taskId, phaseId, record, startPath)
				}),

			create: (
				taskId: string,
				phaseId?: string,
				draft = false,
				startPath: string = process.cwd(),
				options: PullRequestOptions = {},
			) =>
				Effect.gen(function* () {
					const service = yield* PullRequestService
					const fs = yield* FileSystemService
					const tasks = yield* TaskService
					const phases = yield* PhaseService
					const worktrees = yield* WorktreeService
					const readiness = yield* ReadinessService
					const workbase = yield* WorkbaseService
					const requestedTask = yield* tasks.show(taskId, startPath)
					if ("review" in requestedTask.data) {
						return yield* new PullRequestError({
							message: `Review task '${taskId}' cannot create a delivery pull request`,
						})
					}
					yield* readiness.guard(
						"pr",
						taskId,
						phaseId,
						startPath,
						options.force,
					)
					const workspace = yield* worktrees.materialize(
						taskId,
						phaseId,
						startPath,
						options,
					)
					const task = yield* tasks.show(taskId, workspace.root)
					if ("review" in task.data) {
						return yield* new PullRequestError({
							message: `Review task '${taskId}' cannot create a delivery pull request`,
						})
					}
					const execution =
						"phases" in task.data
							? (yield* phases.show(taskId, phaseId!, workspace.root)).data
							: task.data
					const { config } = yield* workbase.loadConfig(workspace.root)
					if (!workspace.writablePath) {
						return yield* new PullRequestError({
							message: `Task '${taskId}' has no writable checkout`,
						})
					}
					const remote = config.delivery?.remote ?? "origin"

					const status = yield* fs.runCommand(
						["git", "-C", workspace.writablePath, "status", "--porcelain"],
						{ captureOutput: true },
					)
					if (status.exitCode !== 0) {
						return yield* new PullRequestError({
							message: `Failed to inspect worktree status: ${status.stderr}`,
						})
					}
					if (status.stdout) {
						return yield* new PullRequestError({
							message: "Cannot create a PR with a dirty worktree",
						})
					}

					const push = yield* fs.runCommand(
						[
							"git",
							"-C",
							workspace.writablePath,
							"push",
							"--set-upstream",
							remote,
							execution.branch,
						],
						{ captureOutput: true },
					)
					if (push.exitCode !== 0) {
						return yield* new PullRequestError({
							message: `Failed to push branch: ${push.stderr}`,
						})
					}

					const remoteResult = yield* fs.runCommand(
						["git", "-C", workspace.writablePath, "remote", "get-url", remote],
						{ captureOutput: true },
					)
					if (remoteResult.exitCode !== 0) {
						return yield* new PullRequestError({
							message: `Failed to inspect delivery remote '${remote}': ${remoteResult.stderr}`,
						})
					}
					const repository = repositoryFromRemote(remoteResult.stdout.trim())
					const resolved = config.delivery
						? resolveDeliveryCommand(config.delivery, "create", {
								repository,
								branch: execution.branch,
								base: execution.base,
								draft: String(draft),
								url: "",
								identifier: "",
							})
						: {
								argv: [
									"gh",
									"pr",
									"create",
									"--fill",
									"--base",
									execution.base,
									...(draft ? ["--draft"] : []),
								],
								environment: {},
							}
					const created = yield* fs.runCommand(resolved.argv, {
						cwd: workspace.writablePath,
						captureOutput: true,
						env: resolved.environment,
					})
					if (created.exitCode !== 0) {
						return yield* new PullRequestError({
							message: `Failed to create pull request: ${created.stderr}`,
						})
					}
					const record = yield* Effect.try({
						try: () => {
							if (config.delivery) return parsePullRequestRecord(created.stdout)
							const url = created.stdout.split(/\s+/).find((value) => {
								try {
									recordFromGitHubUrl(value)
									return true
								} catch {
									return false
								}
							})
							if (!url)
								throw new Error("GitHub CLI did not return a pull request URL")
							return { ...normalizePullRequestRecord(url), draft }
						},
						catch: (cause) =>
							new PullRequestError({
								message: cause instanceof Error ? cause.message : String(cause),
							}),
					})
					if (
						config.delivery &&
						(record.provider !== config.delivery.provider ||
							record.repository.toLowerCase() !== repository.toLowerCase())
					) {
						return yield* new PullRequestError({
							message:
								"Delivery provider returned a record for the wrong provider or repository",
						})
					}
					return yield* service.setRecord(
						taskId,
						phaseId,
						record,
						workspace.root,
					)
				}),
		}),
	},
) {}
