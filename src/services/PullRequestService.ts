import { Data, Effect } from "effect"
import { FileSystemService } from "./FileSystemService"
import { WorkbaseService } from "./WorkbaseService"
import { WorktreeService } from "./WorktreeService"
import type { BaseCommandOptions } from "../utils/command"
import { TaskService } from "./TaskService"
import { PhaseService } from "./PhaseService"
import { ReadinessService } from "./ReadinessService"
import { VersionControlService } from "./VersionControlService"
import {
	formatMarkdownDocument,
	parseFrontmatter,
} from "../workbase/frontmatter"
import type { PullRequestRecord } from "../workbase/schemas"
import {
	normalizePullRequestRecord,
	parsePullRequestRecord,
	recordFromGitHubUrl,
	repositoryFromRemote,
	resolveDeliveryCommand,
	resolveGitHubCreateCommand,
} from "../workbase/delivery-command"

class PullRequestError extends Data.TaggedError("PullRequestError")<{
	readonly message: string
}> {}

interface PullRequestOptions extends BaseCommandOptions {
	readonly force?: boolean
	readonly title?: string
	readonly head?: string
	readonly base?: string
	readonly labels?: readonly string[]
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
					if ("completion" in target.data && target.data.completion) {
						return yield* new PullRequestError({
							message:
								"Reopen non-PR completed work before recording a pull request",
						})
					}
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
					const versionControl = yield* VersionControlService
					const requestedTask = yield* tasks.show(taskId, startPath)
					if ("review" in requestedTask.data) {
						return yield* new PullRequestError({
							message: `Review task '${taskId}' cannot create a delivery pull request`,
						})
					}
					const target =
						"phases" in requestedTask.data
							? phaseId
								? yield* phases.show(taskId, phaseId, startPath)
								: yield* new PullRequestError({
										message: `Task '${taskId}' requires a phase ID`,
									})
							: requestedTask
					if ("completion" in target.data && target.data.completion) {
						return yield* new PullRequestError({
							message:
								"Reopen non-PR completed work before creating a pull request",
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
					const workspaceTask = yield* tasks.show(taskId, workspace.root)
					if ("review" in workspaceTask.data) {
						return yield* new PullRequestError({
							message: `Review task '${taskId}' cannot create a delivery pull request`,
						})
					}
					const execution =
						"phases" in workspaceTask.data
							? (yield* phases.show(taskId, phaseId!, workspace.root)).data
							: workspaceTask.data
					const { config } = yield* workbase.loadConfig(workspace.root)
					const backend = yield* versionControl.forWorkbase(workspace.root)
					if (!workspace.writablePath) {
						return yield* new PullRequestError({
							message: `Task '${taskId}' has no writable checkout`,
						})
					}
					const remote = config.delivery?.remote ?? "origin"
					if (options.head && options.head !== execution.branch) {
						return yield* new PullRequestError({
							message: `Requested head '${options.head}' does not match declared branch '${execution.branch}'`,
						})
					}
					if (options.base && options.base !== execution.base) {
						return yield* new PullRequestError({
							message: `Requested base '${options.base}' does not match declared base '${execution.base}'`,
						})
					}
					if (
						config.delivery &&
						(options.title || (options.labels?.length ?? 0) > 0)
					) {
						return yield* new PullRequestError({
							message:
								"Task-aware --title and --label options require the default GitHub delivery provider",
						})
					}

					const dirty = yield* backend.workspaceDirty(workspace.writablePath)
					if (dirty === null) {
						return yield* new PullRequestError({
							message: "Failed to inspect worktree status",
						})
					}
					if (dirty) {
						return yield* new PullRequestError({
							message: "Cannot create a PR with a dirty worktree",
						})
					}

					yield* backend.push(workspace.writablePath, remote, execution.branch)
					const defaults =
						backend.kind === "jj"
							? yield* backend.pullRequestDefaults(
									workspace.writablePath,
									execution.base,
								)
							: null
					if (backend.kind === "jj" && !defaults) {
						return yield* new PullRequestError({
							message:
								"Failed to derive pull request title and body from jj commits",
						})
					}

					const remoteUrl = yield* backend.remoteUrl(
						workspace.writablePath,
						remote,
					)
					if (!remoteUrl) {
						return yield* new PullRequestError({
							message: `Failed to inspect delivery remote '${remote}'`,
						})
					}
					const repository = repositoryFromRemote(remoteUrl)
					const resolved = config.delivery
						? resolveDeliveryCommand(config.delivery, "create", {
								repository,
								branch: execution.branch,
								base: execution.base,
								draft: String(draft),
								url: "",
								identifier: "",
							})
						: resolveGitHubCreateCommand({
								base: execution.base,
								branch: execution.branch,
								repository,
								draft,
								vcs: config.vcs ?? "git",
								title: options.title,
								head: options.head,
								labels: options.labels,
								...(defaults ? { defaults } : {}),
							})
					const gitEnvironment = config.delivery
						? {}
						: yield* backend.gitEnvironment(workspace.writablePath)
					const created = yield* fs.runCommand(resolved.argv, {
						cwd: workspace.writablePath,
						captureOutput: true,
						env: { ...gitEnvironment, ...resolved.environment },
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
							const normalized = normalizePullRequestRecord(url)
							return {
								...normalized,
								headRepository: repository,
								headBranch: execution.branch,
								baseRepository: normalized.repository,
								baseBranch: execution.base,
								draft,
							}
						},
						catch: (cause) =>
							new PullRequestError({
								message: cause instanceof Error ? cause.message : String(cause),
							}),
					})
					if (
						config.delivery &&
						(record.provider !== config.delivery.provider ||
							(record.headRepository ?? record.repository).toLowerCase() !==
								repository.toLowerCase())
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
