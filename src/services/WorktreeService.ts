import { Data, Effect } from "effect"
import { basename, dirname, join, resolve } from "node:path"
import { FileSystemService } from "./FileSystemService"
import { WorkbaseService } from "./WorkbaseService"
import { TaskService } from "./TaskService"
import { PhaseService } from "./PhaseService"
import {
	expandWorktreeCreateCommand,
	worktreeCommandEnvironment,
} from "../workbase/worktree-command"
import type { RepositoryReference } from "../workbase/schemas"
import type { BaseCommandOptions } from "../utils/command"
import { createLoggers } from "../utils/effect"

class WorktreeError extends Data.TaggedError("WorktreeError")<{
	readonly message: string
}> {}

interface ExecutionWorkspace {
	readonly root: string
	readonly taskPath: string
	readonly phasePath: string | null
	readonly codePath: string
	readonly writablePath: string
	readonly repo: string
	readonly repos: readonly RepositoryReference[]
}

interface GitWorktree {
	readonly path: string
	readonly head?: string
	readonly branch?: string
}

const parseWorktreeList = (output: string): readonly GitWorktree[] => {
	const worktrees: GitWorktree[] = []
	let current: { path: string; head?: string; branch?: string } | undefined

	for (const field of output.split("\0")) {
		if (field.startsWith("worktree ")) {
			if (current) worktrees.push(current)
			current = { path: field.slice("worktree ".length) }
		} else if (current && field.startsWith("HEAD ")) {
			current.head = field.slice("HEAD ".length)
		} else if (current && field.startsWith("branch ")) {
			current.branch = field.slice("branch ".length)
		}
	}
	if (current) worktrees.push(current)

	return worktrees
}

const formatCommand = (args: readonly string[]) =>
	args
		.map((argument) =>
			/^[A-Za-z0-9_./:=+@%-]+$/.test(argument)
				? argument
				: `'${argument.replaceAll("'", `'\\''`)}'`,
		)
		.join(" ")

export class WorktreeService extends Effect.Service<WorktreeService>()(
	"WorktreeService",
	{
		sync: () => ({
			materialize: (
				taskId: string,
				phaseId?: string,
				startPath: string = process.cwd(),
				options: BaseCommandOptions = {},
			) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const workbase = yield* WorkbaseService
					const tasks = yield* TaskService
					const phases = yield* PhaseService
					const { verboseLog } = createLoggers(options)
					const forwardCommandOutput =
						options.verbose === true && !options.silent && !options.json
					const { root, config } = yield* workbase.loadConfig(startPath)
					const report = yield* workbase.validate(root)
					const ownershipIssue = report.issues.find((issue) =>
						issue.message.startsWith("Writable branch "),
					)
					if (ownershipIssue) {
						return yield* new WorktreeError({
							message: `${ownershipIssue.path}: ${ownershipIssue.message}`,
						})
					}
					const task = yield* tasks.show(taskId, root)

					let execution: {
						repo: string
						repos?: readonly RepositoryReference[]
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
					const checkouts: readonly (
						| { readonly repo: string; readonly branch: string }
						| RepositoryReference
					)[] = [
						{ repo: execution.repo, branch: execution.branch },
						...(execution.repos ?? []),
					]
					for (const checkout of checkouts) {
						const alias = checkout.repo
						const repositoryPath = join(root, "repos", alias)
						const checkoutPath = join(codePath, alias)
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

						const listed = yield* fs.runCommand(
							[
								"git",
								"-C",
								repositoryPath,
								"worktree",
								"list",
								"--porcelain",
								"-z",
							],
							{ captureOutput: true },
						)
						if (listed.exitCode !== 0) {
							return yield* new WorktreeError({
								message: `Failed to inspect worktrees for '${alias}': ${listed.stderr}`,
							})
						}
						const canonicalCodePath = yield* fs.realPath(codePath)
						const canonicalCheckoutPath = join(canonicalCodePath, alias)
						const worktrees: GitWorktree[] = []
						for (const worktree of parseWorktreeList(listed.stdout)) {
							worktrees.push({
								...worktree,
								path: (yield* fs.exists(worktree.path))
									? yield* fs.realPath(worktree.path)
									: resolve(worktree.path),
							})
						}
						const registeredAtPath = worktrees.find(
							(worktree) => worktree.path === canonicalCheckoutPath,
						)

						if ("branch" in checkout) {
							const branchRef = `refs/heads/${checkout.branch}`
							const branchWorktree = worktrees.find(
								(worktree) => worktree.branch === branchRef,
							)
							if (
								branchWorktree &&
								branchWorktree.path !== canonicalCheckoutPath
							) {
								return yield* new WorktreeError({
									message: `Branch '${checkout.branch}' for repository '${alias}' is already checked out at ${branchWorktree.path}`,
								})
							}
							if (yield* fs.isDirectory(checkoutPath)) {
								if (registeredAtPath?.branch === branchRef) continue
								return yield* new WorktreeError({
									message: `Existing checkout ${checkoutPath} is not registered to branch '${checkout.branch}'`,
								})
							}
							if (registeredAtPath) {
								return yield* new WorktreeError({
									message: `Worktree registry contains a missing checkout at ${checkoutPath}`,
								})
							}

							let args: string[]
							let env: Record<string, string> | undefined
							if (config.worktreeCreateCommand) {
								const variables = {
									repo: repositoryPath,
									worktree: checkoutPath,
									branch: checkout.branch,
									base: execution.base,
								}
								try {
									args = expandWorktreeCreateCommand(
										config.worktreeCreateCommand,
										variables,
									)
								} catch (cause) {
									return yield* new WorktreeError({
										message:
											cause instanceof Error
												? cause.message
												: "Invalid worktreeCreateCommand",
									})
								}
								env = worktreeCommandEnvironment(variables)
							} else {
								const branchExists = yield* fs.runCommand(
									[
										"git",
										"-C",
										repositoryPath,
										"show-ref",
										"--verify",
										branchRef,
									],
									{ captureOutput: true },
								)
								if (branchExists.exitCode !== 0) {
									const createBranch = yield* fs.runCommand(
										[
											"git",
											"-C",
											repositoryPath,
											"branch",
											checkout.branch,
											execution.base,
										],
										{ captureOutput: true },
									)
									if (createBranch.exitCode !== 0) {
										return yield* new WorktreeError({
											message: `Failed to create branch '${checkout.branch}': ${createBranch.stderr}`,
										})
									}
								}
								args = [
									"git",
									"-C",
									repositoryPath,
									"worktree",
									"add",
									checkoutPath,
									checkout.branch,
								]
							}

							if (config.worktreeCreateCommand) {
								verboseLog(`Running worktree command: ${formatCommand(args)}`)
							}
							const result = yield* fs.runCommand(args, {
								cwd: repositoryPath,
								captureOutput: true,
								forwardOutput:
									config.worktreeCreateCommand && forwardCommandOutput,
								env,
							})
							if (result.exitCode !== 0) {
								return yield* new WorktreeError({
									message: `Failed to create worktree for '${alias}': ${result.stderr}`,
								})
							}
							if (!(yield* fs.isDirectory(checkoutPath))) {
								return yield* new WorktreeError({
									message: `Worktree command did not create ${checkoutPath}`,
								})
							}
						} else {
							const resolvedRef = yield* fs.runCommand(
								[
									"git",
									"-C",
									repositoryPath,
									"rev-parse",
									"--verify",
									`${checkout.ref}^{commit}`,
								],
								{ captureOutput: true },
							)
							if (resolvedRef.exitCode !== 0) {
								return yield* new WorktreeError({
									message: `Reference '${checkout.ref}' for repository '${alias}' does not resolve to a commit`,
								})
							}
							const commit = resolvedRef.stdout.trim()
							if (yield* fs.isDirectory(checkoutPath)) {
								if (!registeredAtPath) {
									return yield* new WorktreeError({
										message: `Existing checkout ${checkoutPath} is not registered as a Git worktree`,
									})
								}
								if (registeredAtPath.branch) {
									return yield* new WorktreeError({
										message: `Reference checkout ${checkoutPath} is attached to branch '${registeredAtPath.branch.replace(/^refs\/heads\//, "")}'`,
									})
								}
								const currentHead = yield* fs.runCommand(
									["git", "-C", checkoutPath, "rev-parse", "HEAD"],
									{ captureOutput: true },
								)
								if (
									currentHead.exitCode === 0 &&
									currentHead.stdout.trim() === commit
								) {
									continue
								}
								return yield* new WorktreeError({
									message: `Existing checkout ${checkoutPath} does not match reference '${checkout.ref}' (${commit})`,
								})
							}
							if (registeredAtPath) {
								return yield* new WorktreeError({
									message: `Worktree registry contains a missing checkout at ${checkoutPath}`,
								})
							}
							const result = yield* fs.runCommand(
								[
									"git",
									"-C",
									repositoryPath,
									"worktree",
									"add",
									"--detach",
									checkoutPath,
									commit,
								],
								{ captureOutput: true },
							)
							if (result.exitCode !== 0) {
								return yield* new WorktreeError({
									message: `Failed to create worktree for '${alias}': ${result.stderr}`,
								})
							}
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

			remove: (
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
						repos?: readonly RepositoryReference[]
					}
					let codePath: string
					if ("phases" in task.data) {
						if (!phaseId) {
							return yield* new WorktreeError({
								message: `Task '${taskId}' has multiple phases; phase ID is required`,
							})
						}
						const phase = yield* phases.show(taskId, phaseId, root)
						execution = phase.data
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

					const codeDirectoryExists = yield* fs.isDirectory(codePath)
					const removed: string[] = []
					for (const alias of [
						execution.repo,
						...(execution.repos ?? []).map((reference) => reference.repo),
					]) {
						const repositoryPath = join(root, "repos", alias)
						const checkoutPath = join(codePath, alias)
						const listed = yield* fs.runCommand(
							[
								"git",
								"-C",
								repositoryPath,
								"worktree",
								"list",
								"--porcelain",
								"-z",
							],
							{ captureOutput: true },
						)
						if (listed.exitCode !== 0) {
							return yield* new WorktreeError({
								message: `Failed to inspect worktrees for '${alias}': ${listed.stderr}`,
							})
						}

						const checkoutExists = yield* fs.isDirectory(checkoutPath)
						const canonicalCheckoutPath = checkoutExists
							? yield* fs.realPath(checkoutPath)
							: join(
									yield* fs.realPath(dirname(codePath)),
									basename(codePath),
									alias,
								)
						let registeredPath: string | undefined
						for (const worktree of parseWorktreeList(listed.stdout)) {
							const worktreePath = (yield* fs.exists(worktree.path))
								? yield* fs.realPath(worktree.path)
								: resolve(worktree.path)
							if (worktreePath === canonicalCheckoutPath) {
								registeredPath = worktreePath
								break
							}
						}
						if (!registeredPath) {
							if (checkoutExists) {
								return yield* new WorktreeError({
									message: `Existing checkout ${checkoutPath} is not registered as a Git worktree`,
								})
							}
							continue
						}

						const result = yield* fs.runCommand(
							[
								"git",
								"-C",
								repositoryPath,
								"worktree",
								"remove",
								...(!checkoutExists ? ["--force"] : []),
								checkoutExists ? checkoutPath : registeredPath,
							],
							{ captureOutput: true },
						)
						if (result.exitCode !== 0) {
							return yield* new WorktreeError({
								message: `Failed to remove worktree for '${alias}': ${result.stderr}`,
							})
						}
						if (checkoutExists) removed.push(checkoutPath)
					}

					if (codeDirectoryExists && (yield* fs.isDirectory(codePath))) {
						const remaining = yield* fs.readDirectory(codePath)
						if (remaining.length > 0) {
							return yield* new WorktreeError({
								message: `Cannot remove ${codePath}; it contains unmanaged entries: ${remaining.map((entry) => entry.name).join(", ")}`,
							})
						}
						yield* fs.deleteDirectory(codePath)
					}
					return removed
				}),
		}),
	},
) {}
