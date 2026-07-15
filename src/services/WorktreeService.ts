import { Data, Effect } from "effect"
import { dirname, join } from "node:path"
import { FileSystemService } from "./FileSystemService"
import { WorkbaseService } from "./WorkbaseService"
import { TaskService } from "./TaskService"
import { PhaseService } from "./PhaseService"

class WorktreeError extends Data.TaggedError("WorktreeError")<{
	readonly message: string
}> {}

export interface ExecutionWorkspace {
	readonly root: string
	readonly taskPath: string
	readonly phasePath: string | null
	readonly codePath: string
	readonly writablePath: string
	readonly repo: string
	readonly repos: readonly string[]
}

export class WorktreeService extends Effect.Service<WorktreeService>()(
	"WorktreeService",
	{
		sync: () => ({
			materialize: (
				taskId: string,
				phaseId?: string,
				startPath: string = process.cwd(),
			) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const workbase = yield* WorkbaseService
					const tasks = yield* TaskService
					const phases = yield* PhaseService
					const root = yield* workbase.discover(startPath)
					const task = yield* tasks.show(taskId, root)

					let execution: {
						repo: string
						repos?: readonly string[]
						branch: string
						base: string
					}
					let phasePath: string | null = null
					let codePath: string
					if ("phases" in task.data) {
						if (!phaseId) {
							return yield* new WorktreeError({
								message: `Task '${taskId}' has multiple phases; phase ID is required`,
							})
						}
						const phase = yield* phases.show(taskId, phaseId, root)
						execution = phase.data
						phasePath = phase.path
						codePath = join(dirname(phase.path), "code")
					} else {
						if (phaseId) {
							return yield* new WorktreeError({
								message: `Task '${taskId}' is single-phase and does not accept a phase ID`,
							})
						}
						execution = task.data
						codePath = join(dirname(task.path), "code")
					}

					yield* fs.createDirectory(codePath)
					const aliases = [execution.repo, ...(execution.repos ?? [])]
					for (const alias of aliases) {
						const repositoryPath = join(root, "repos", alias)
						const checkoutPath = join(codePath, alias)
						if (yield* fs.isDirectory(checkoutPath)) continue
						if (!(yield* fs.exists(repositoryPath))) {
							return yield* new WorktreeError({
								message: `Repository alias '${alias}' does not exist`,
							})
						}

						const remote = yield* fs.runCommand(
							["git", "-C", repositoryPath, "remote", "get-url", "origin"],
							{ captureOutput: true },
						)
						if (remote.exitCode === 0) {
							const fetch = yield* fs.runCommand(
								["git", "-C", repositoryPath, "fetch", "origin"],
								{ captureOutput: true },
							)
							if (fetch.exitCode !== 0) {
								return yield* new WorktreeError({
									message: `Failed to fetch '${alias}': ${fetch.stderr}`,
								})
							}
						}

						const args = ["git", "-C", repositoryPath, "worktree", "add"]
						if (alias === execution.repo) {
							const branchExists = yield* fs.runCommand(
								[
									"git",
									"-C",
									repositoryPath,
									"show-ref",
									"--verify",
									`refs/heads/${execution.branch}`,
								],
								{ captureOutput: true },
							)
							if (branchExists.exitCode === 0) {
								args.push(checkoutPath, execution.branch)
							} else {
								args.push("-b", execution.branch, checkoutPath, execution.base)
							}
						} else {
							args.push("--detach", checkoutPath, "HEAD")
						}

						const result = yield* fs.runCommand(args, { captureOutput: true })
						if (result.exitCode !== 0) {
							return yield* new WorktreeError({
								message: `Failed to create worktree for '${alias}': ${result.stderr}`,
							})
						}
					}

					return {
						root,
						taskPath: task.path,
						phasePath,
						codePath,
						writablePath: join(codePath, execution.repo),
						repo: execution.repo,
						repos: execution.repos ?? [],
					} satisfies ExecutionWorkspace
				}),
		}),
	},
) {}
