import { Data, Effect } from "effect"
import { FileSystemService } from "./FileSystemService"
import { WorkbaseService } from "./WorkbaseService"
import { WorktreeService } from "./WorktreeService"
import type { BaseCommandOptions } from "../utils/command"
import { TaskService } from "./TaskService"
import { PhaseService } from "./PhaseService"
import {
	formatMarkdownDocument,
	parseFrontmatter,
} from "../workbase/frontmatter"

class PullRequestError extends Data.TaggedError("PullRequestError")<{
	readonly message: string
}> {}

const PR_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+\/?$/

export class PullRequestService extends Effect.Service<PullRequestService>()(
	"PullRequestService",
	{
		sync: () => ({
			setUrl: (
				taskId: string,
				phaseId: string | undefined,
				url: string,
				startPath: string = process.cwd(),
			) =>
				Effect.gen(function* () {
					if (!PR_URL.test(url)) {
						return yield* new PullRequestError({
							message: `Invalid GitHub pull request URL: ${url}`,
						})
					}
					const fs = yield* FileSystemService
					const workbase = yield* WorkbaseService
					const tasks = yield* TaskService
					const phases = yield* PhaseService
					const root = yield* workbase.discover(startPath)
					const task = yield* tasks.show(taskId, root)
					const record =
						"phases" in task.data
							? phaseId
								? yield* phases.show(taskId, phaseId, root)
								: yield* new PullRequestError({
										message: `Task '${taskId}' requires a phase ID`,
									})
							: task
					const parsed = yield* parseFrontmatter(record.content, record.path)
					const data = { ...record.data, pr: url }
					yield* fs.writeFile(
						record.path,
						formatMarkdownDocument(data, parsed.body),
					)
					return url
				}),

			create: (
				taskId: string,
				phaseId?: string,
				draft = false,
				startPath: string = process.cwd(),
				options: BaseCommandOptions = {},
			) =>
				Effect.gen(function* () {
					const service = yield* PullRequestService
					const fs = yield* FileSystemService
					const tasks = yield* TaskService
					const phases = yield* PhaseService
					const worktrees = yield* WorktreeService
					const workspace = yield* worktrees.materialize(
						taskId,
						phaseId,
						startPath,
						options,
					)
					const task = yield* tasks.show(taskId, workspace.root)
					const execution =
						"phases" in task.data
							? (yield* phases.show(taskId, phaseId!, workspace.root)).data
							: task.data

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
							"origin",
							execution.branch,
						],
						{ captureOutput: true },
					)
					if (push.exitCode !== 0) {
						return yield* new PullRequestError({
							message: `Failed to push branch: ${push.stderr}`,
						})
					}

					const args = [
						"gh",
						"pr",
						"create",
						"--fill",
						"--base",
						execution.base,
					]
					if (draft) args.push("--draft")
					const created = yield* fs.runCommand(args, {
						cwd: workspace.writablePath,
						captureOutput: true,
					})
					if (created.exitCode !== 0) {
						return yield* new PullRequestError({
							message: `Failed to create pull request: ${created.stderr}`,
						})
					}
					const url = created.stdout
						.split(/\s+/)
						.find((value) => PR_URL.test(value))
					if (!url) {
						return yield* new PullRequestError({
							message: "GitHub CLI did not return a pull request URL",
						})
					}
					return yield* service.setUrl(taskId, phaseId, url, workspace.root)
				}),
		}),
	},
) {}
