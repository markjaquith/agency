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
import { withWorktreeLocks } from "./WorktreeLock"

class WorktreeError extends Data.TaggedError("WorktreeError")<{
	readonly message: string
	readonly completed?: readonly string[]
	readonly rolledBack?: readonly string[]
	readonly manualRecovery?: readonly string[]
	readonly cause?: unknown
}> {}

interface WorkspaceOperation {
	readonly action: "fetch" | "create-branch" | "create-worktree"
	readonly repo: string
	readonly command: readonly string[]
	readonly status: "planned" | "completed"
}

interface WorkspaceCheckout {
	readonly repo: string
	readonly kind: "writable" | "reference"
	readonly path: string
	readonly requestedRef: string
	readonly resolvedCommit: string | null
	readonly action: "created" | "reused"
}

interface ExecutionWorkspace {
	readonly root: string
	readonly taskPath: string
	readonly phasePath: string | null
	readonly codePath: string
	readonly writablePath: string
	readonly repo: string
	readonly repos: readonly RepositoryReference[]
	readonly dryRun: boolean
	readonly checkouts: readonly WorkspaceCheckout[]
	readonly operations: readonly WorkspaceOperation[]
}

interface GitWorktree {
	readonly path: string
	readonly head?: string
	readonly branch?: string
}

export interface WorktreeRemovalSnapshot {
	readonly path: string
	readonly repositoryPath: string
	readonly head: string
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

const isCommitId = (ref: string) => /^[0-9a-f]{40,64}$/i.test(ref)

const originRef = (ref: string) =>
	ref.replace(/^refs\/remotes\/origin\//, "").replace(/^origin\//, "")

interface MaterializeOptions extends BaseCommandOptions {
	readonly force?: boolean
}

interface RemoveOptions extends BaseCommandOptions {
	readonly snapshots?: WorktreeRemovalSnapshot[]
	readonly lockHeld?: boolean
}

export class WorktreeService extends Effect.Service<WorktreeService>()(
	"WorktreeService",
	{
		sync: () => ({
			materialize: (
				taskId: string,
				phaseId?: string,
				startPath: string = process.cwd(),
				options: MaterializeOptions = {},
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
					return yield* withWorktreeLocks(
						root,
						[{ taskId, ...(phaseId ? { phaseId } : {}) }],
						Effect.gen(function* () {
							const report = yield* workbase.validate(root)
							const validationIssue = report.issues[0]
							if (validationIssue && !options.force) {
								return yield* new WorktreeError({
									message: `${validationIssue.path}: ${validationIssue.message}`,
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

							const requestedCheckouts: readonly (
								| { readonly repo: string; readonly branch: string }
								| RepositoryReference
							)[] = [
								{ repo: execution.repo, branch: execution.branch },
								...(execution.repos ?? []),
							]
							const canonicalCodePath = (yield* fs.exists(codePath))
								? yield* fs.realPath(codePath)
								: resolve(codePath)
							const preflightCommits = new Map<string, string>()
							const preexistingBranches = new Set<string>()
							for (const checkout of requestedCheckouts) {
								const alias = checkout.repo
								const repositoryPath = join(root, "repos", alias)
								const checkoutPath = join(codePath, alias)
								if (!(yield* fs.exists(repositoryPath))) {
									return yield* new WorktreeError({
										message: `Repository alias '${alias}' does not exist`,
									})
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
								const checkoutExists = yield* fs.isDirectory(checkoutPath)
								if ("branch" in checkout) {
									const branchRef = `refs/heads/${checkout.branch}`
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
									if (branchExists.exitCode === 0)
										preexistingBranches.add(`${alias}:${checkout.branch}`)
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
									if (
										checkoutExists &&
										registeredAtPath?.branch !== branchRef
									) {
										return yield* new WorktreeError({
											message: `Existing checkout ${checkoutPath} is not registered to branch '${checkout.branch}'`,
										})
									}
									if (!checkoutExists && registeredAtPath) {
										return yield* new WorktreeError({
											message: `Worktree registry contains a missing checkout at ${checkoutPath}`,
										})
									}
									if (!checkoutExists && branchExists.exitCode !== 0) {
										const localBase = yield* fs.runCommand(
											[
												"git",
												"-C",
												repositoryPath,
												"rev-parse",
												"--verify",
												`${execution.base}^{commit}`,
											],
											{ captureOutput: true },
										)
										if (localBase.exitCode !== 0) {
											const remoteBase = yield* fs.runCommand(
												[
													"git",
													"-C",
													repositoryPath,
													"ls-remote",
													"origin",
													originRef(execution.base),
												],
												{ captureOutput: true },
											)
											if (
												remoteBase.exitCode !== 0 ||
												!remoteBase.stdout.trim()
											) {
												return yield* new WorktreeError({
													message: `Base '${execution.base}' for repository '${alias}' does not resolve to a commit`,
												})
											}
										}
									}
									if (config.worktreeCreateCommand) {
										try {
											expandWorktreeCreateCommand(
												config.worktreeCreateCommand,
												{
													repo: repositoryPath,
													worktree: checkoutPath,
													branch: checkout.branch,
													base: execution.base,
												},
											)
										} catch (cause) {
											return yield* new WorktreeError({
												message:
													cause instanceof Error
														? cause.message
														: "Invalid worktreeCreateCommand",
											})
										}
									}
								} else {
									if (checkoutExists && !registeredAtPath) {
										return yield* new WorktreeError({
											message: `Existing checkout ${checkoutPath} is not registered as a Git worktree`,
										})
									}
									if (registeredAtPath?.branch) {
										return yield* new WorktreeError({
											message: `Reference checkout ${checkoutPath} is attached to branch '${registeredAtPath.branch.replace(/^refs\/heads\//, "")}'`,
										})
									}
									if (!checkoutExists && registeredAtPath) {
										return yield* new WorktreeError({
											message: `Worktree registry contains a missing checkout at ${checkoutPath}`,
										})
									}
									let commit: string | undefined
									if (!isCommitId(checkout.ref)) {
										const remote = yield* fs.runCommand(
											[
												"git",
												"-C",
												repositoryPath,
												"ls-remote",
												"origin",
												originRef(checkout.ref),
											],
											{ captureOutput: true },
										)
										if (remote.exitCode === 0 && remote.stdout.trim())
											commit = remote.stdout.trim().split(/\s+/)[0]
									}
									if (!commit) {
										const local = yield* fs.runCommand(
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
										if (local.exitCode === 0) commit = local.stdout.trim()
									}
									if (!commit) {
										return yield* new WorktreeError({
											message: `Reference '${checkout.ref}' for repository '${alias}' does not resolve to a commit`,
										})
									}
									preflightCommits.set(alias, commit)
									if (checkoutExists && registeredAtPath) {
										const currentHead = yield* fs.runCommand(
											["git", "-C", checkoutPath, "rev-parse", "HEAD"],
											{ captureOutput: true },
										)
										if (
											currentHead.exitCode !== 0 ||
											currentHead.stdout.trim() !== commit
										) {
											return yield* new WorktreeError({
												message: `Existing checkout ${checkoutPath} does not match reference '${checkout.ref}' (${commit})`,
											})
										}
									}
								}
							}

							if (!options.dryRun) yield* fs.createDirectory(codePath)
							const operations: WorkspaceOperation[] = []
							const checkoutReports: WorkspaceCheckout[] = []
							const checkouts = requestedCheckouts
							const createdBranches: { repo: string; branch: string }[] = []
							const preexistingPaths = new Set<string>()
							for (const checkout of checkouts) {
								const path = join(codePath, checkout.repo)
								if (yield* fs.isDirectory(path)) preexistingPaths.add(path)
							}
							const materialized = yield* Effect.gen(function* () {
								for (const checkout of checkouts) {
									const alias = checkout.repo
									const repositoryPath = join(root, "repos", alias)
									const checkoutPath = join(codePath, alias)
									if (!(yield* fs.exists(repositoryPath))) {
										return yield* new WorktreeError({
											message: `Repository alias '${alias}' does not exist`,
										})
									}

									const fetchOrigin = (ref?: string) =>
										Effect.gen(function* () {
											const remote = yield* fs.runCommand(
												[
													"git",
													"-C",
													repositoryPath,
													"remote",
													"get-url",
													"origin",
												],
												{ captureOutput: true },
											)
											if (remote.exitCode !== 0) return false
											const command = [
												"git",
												"-C",
												repositoryPath,
												"fetch",
												"origin",
												...(ref ? [ref] : []),
											]
											if (options.dryRun) {
												operations.push({
													action: "fetch",
													repo: alias,
													command,
													status: "planned",
												})
												return false
											}

											const fetch = yield* fs.runCommand(command, {
												captureOutput: true,
											})
											if (fetch.exitCode !== 0) {
												return yield* new WorktreeError({
													message: `Failed to fetch '${alias}': ${fetch.stderr}`,
												})
											}
											operations.push({
												action: "fetch",
												repo: alias,
												command,
												status: "completed",
											})
											return true
										})

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
									const canonicalCodePath = (yield* fs.exists(codePath))
										? yield* fs.realPath(codePath)
										: resolve(codePath)
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
											if (registeredAtPath?.branch === branchRef) {
												checkoutReports.push({
													repo: alias,
													kind: "writable",
													path: checkoutPath,
													requestedRef: checkout.branch,
													resolvedCommit: registeredAtPath.head ?? null,
													action: "reused",
												})
												continue
											}
											return yield* new WorktreeError({
												message: `Existing checkout ${checkoutPath} is not registered to branch '${checkout.branch}'`,
											})
										}
										if (registeredAtPath) {
											return yield* new WorktreeError({
												message: `Worktree registry contains a missing checkout at ${checkoutPath}`,
											})
										}
										yield* fetchOrigin()

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
												const command = [
													"git",
													"-C",
													repositoryPath,
													"branch",
													checkout.branch,
													execution.base,
												]
												operations.push({
													action: "create-branch",
													repo: alias,
													command,
													status: options.dryRun ? "planned" : "completed",
												})
												if (!options.dryRun) {
													const createBranch = yield* fs.runCommand(command, {
														captureOutput: true,
													})
													if (createBranch.exitCode !== 0) {
														return yield* new WorktreeError({
															message: `Failed to create branch '${checkout.branch}': ${createBranch.stderr}`,
														})
													}
													createdBranches.push({
														repo: alias,
														branch: checkout.branch,
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
										if (options.dryRun) {
											operations.push({
												action: "create-worktree",
												repo: alias,
												command: args,
												status: "planned",
											})
											let resolved = yield* fs.runCommand(
												[
													"git",
													"-C",
													repositoryPath,
													"rev-parse",
													"--verify",
													`${checkout.branch}^{commit}`,
												],
												{ captureOutput: true },
											)
											if (resolved.exitCode !== 0) {
												resolved = yield* fs.runCommand(
													[
														"git",
														"-C",
														repositoryPath,
														"rev-parse",
														"--verify",
														`${execution.base}^{commit}`,
													],
													{ captureOutput: true },
												)
											}
											checkoutReports.push({
												repo: alias,
												kind: "writable",
												path: checkoutPath,
												requestedRef: checkout.branch,
												resolvedCommit:
													resolved.exitCode === 0
														? resolved.stdout.trim()
														: null,
												action: "created",
											})
											continue
										}

										if (config.worktreeCreateCommand) {
											verboseLog(
												`Running worktree command: ${formatCommand(args)}`,
											)
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
										operations.push({
											action: "create-worktree",
											repo: alias,
											command: args,
											status: "completed",
										})
										const head = yield* fs.runCommand(
											["git", "-C", checkoutPath, "rev-parse", "HEAD"],
											{ captureOutput: true },
										)
										checkoutReports.push({
											repo: alias,
											kind: "writable",
											path: checkoutPath,
											requestedRef: checkout.branch,
											resolvedCommit:
												head.exitCode === 0 ? head.stdout.trim() : null,
											action: "created",
										})
									} else {
										const fetched = isCommitId(checkout.ref)
											? false
											: yield* fetchOrigin(originRef(checkout.ref))
										const resolvedRefName = fetched
											? "FETCH_HEAD"
											: checkout.ref
										const resolvedRef = options.dryRun
											? {
													exitCode: 0,
													stdout: preflightCommits.get(alias)!,
													stderr: "",
												}
											: yield* fs.runCommand(
													[
														"git",
														"-C",
														repositoryPath,
														"rev-parse",
														"--verify",
														`${resolvedRefName}^{commit}`,
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
												checkoutReports.push({
													repo: alias,
													kind: "reference",
													path: checkoutPath,
													requestedRef: checkout.ref,
													resolvedCommit: commit,
													action: "reused",
												})
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
										const command = [
											"git",
											"-C",
											repositoryPath,
											"worktree",
											"add",
											"--detach",
											checkoutPath,
											commit,
										]
										if (options.dryRun) {
											operations.push({
												action: "create-worktree",
												repo: alias,
												command,
												status: "planned",
											})
											checkoutReports.push({
												repo: alias,
												kind: "reference",
												path: checkoutPath,
												requestedRef: checkout.ref,
												resolvedCommit: commit,
												action: "created",
											})
											continue
										}
										const result = yield* fs.runCommand(command, {
											captureOutput: true,
										})
										if (result.exitCode !== 0) {
											return yield* new WorktreeError({
												message: `Failed to create worktree for '${alias}': ${result.stderr}`,
											})
										}
										operations.push({
											action: "create-worktree",
											repo: alias,
											command,
											status: "completed",
										})
										checkoutReports.push({
											repo: alias,
											kind: "reference",
											path: checkoutPath,
											requestedRef: checkout.ref,
											resolvedCommit: commit,
											action: "created",
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
									dryRun: options.dryRun === true,
									checkouts: checkoutReports,
									operations,
								} satisfies ExecutionWorkspace
							}).pipe(
								Effect.catchAll((cause) =>
									Effect.gen(function* () {
										if (options.dryRun) return yield* cause
										const completed = operations
											.filter((operation) => operation.status === "completed")
											.map(
												(operation) => `${operation.action} ${operation.repo}`,
											)
										const rolledBack: string[] = []
										const manualRecovery = operations
											.filter(
												(operation) =>
													operation.action === "fetch" &&
													operation.status === "completed",
											)
											.map(
												(operation) =>
													`Review fetched refs for repository '${operation.repo}'`,
											)
										for (const checkout of [...checkouts].reverse()) {
											const checkoutPath = join(codePath, checkout.repo)
											if (
												preexistingPaths.has(checkoutPath) ||
												!(yield* fs.isDirectory(checkoutPath))
											)
												continue
											const removed = yield* fs.runCommand(
												[
													"git",
													"-C",
													join(root, "repos", checkout.repo),
													"worktree",
													"remove",
													"--force",
													checkoutPath,
												],
												{ captureOutput: true },
											)
											if (removed.exitCode === 0)
												rolledBack.push(`create-worktree ${checkout.repo}`)
											else manualRecovery.push(`Remove ${checkoutPath}`)
										}
										const branchCandidates = new Map(
											[
												...createdBranches,
												...checkouts
													.filter(
														(
															checkout,
														): checkout is {
															repo: string
															branch: string
														} => "branch" in checkout,
													)
													.filter(
														(checkout) =>
															!preexistingBranches.has(
																`${checkout.repo}:${checkout.branch}`,
															),
													),
											].map((branch) => [
												`${branch.repo}:${branch.branch}`,
												branch,
											]),
										).values()
										for (const branch of branchCandidates) {
											const deleted = yield* fs.runCommand(
												[
													"git",
													"-C",
													join(root, "repos", branch.repo),
													"branch",
													"-D",
													branch.branch,
												],
												{ captureOutput: true },
											)
											if (deleted.exitCode === 0)
												rolledBack.push(`create-branch ${branch.repo}`)
											else
												manualRecovery.push(
													`Delete branch '${branch.branch}' in repository '${branch.repo}'`,
												)
										}
										if (
											(yield* fs.isDirectory(codePath)) &&
											(yield* fs.readDirectory(codePath)).length === 0
										)
											yield* fs.deleteDirectory(codePath)
										return yield* new WorktreeError({
											message: `${cause.message}. ${
												manualRecovery.length
													? "Some effects require manual recovery"
													: "Created worktrees and branches were rolled back"
											}`,
											completed,
											rolledBack,
											manualRecovery,
											cause,
										})
									}),
								),
							)
							return materialized
						}),
					)
				}),

			remove: (
				taskId: string,
				phaseId?: string,
				startPath: string = process.cwd(),
				options: RemoveOptions = {},
			) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const workbase = yield* WorkbaseService
					const tasks = yield* TaskService
					const phases = yield* PhaseService
					const root = yield* workbase.discover(startPath)
					const removal = Effect.gen(function* () {
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
						const removalPlans: {
							alias: string
							repositoryPath: string
							checkoutPath: string
							registeredPath: string
							checkoutExists: boolean
							head?: string
							branch?: string
						}[] = []
						const expectedAliases = [
							execution.repo,
							...(execution.repos ?? []).map((reference) => reference.repo),
						]
						if (codeDirectoryExists) {
							const unmanaged = (yield* fs.readDirectory(codePath)).filter(
								(entry) => !expectedAliases.includes(entry.name),
							)
							if (unmanaged.length > 0) {
								return yield* new WorktreeError({
									message: `Cannot remove ${codePath}; it contains unmanaged entries: ${unmanaged.map((entry) => entry.name).join(", ")}`,
								})
							}
						}
						for (const alias of [...expectedAliases]) {
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
							let registered: GitWorktree | undefined
							for (const worktree of parseWorktreeList(listed.stdout)) {
								const worktreePath = (yield* fs.exists(worktree.path))
									? yield* fs.realPath(worktree.path)
									: resolve(worktree.path)
								if (worktreePath === canonicalCheckoutPath) {
									registered = { ...worktree, path: worktreePath }
									break
								}
							}
							if (!registered) {
								if (checkoutExists) {
									return yield* new WorktreeError({
										message: `Existing checkout ${checkoutPath} is not registered as a Git worktree`,
									})
								}
								continue
							}
							if (checkoutExists) {
								const status = yield* fs.runCommand(
									["git", "-C", checkoutPath, "status", "--porcelain"],
									{ captureOutput: true },
								)
								if (status.exitCode !== 0 || status.stdout.trim()) {
									return yield* new WorktreeError({
										message: `Failed to remove worktree for '${alias}': checkout has uncommitted changes`,
									})
								}
							}
							removalPlans.push({
								alias,
								repositoryPath,
								checkoutPath,
								registeredPath: registered.path,
								checkoutExists,
								head: registered.head,
								branch: registered.branch?.replace(/^refs\/heads\//, ""),
							})
						}
						for (const plan of removalPlans) {
							if (!plan.checkoutExists || !plan.head) continue
							options.snapshots?.push({
								path: plan.checkoutPath,
								repositoryPath: plan.repositoryPath,
								head: plan.head,
								...(plan.branch ? { branch: plan.branch } : {}),
							})
						}
						if (options.dryRun) {
							return removalPlans
								.filter((plan) => plan.checkoutExists)
								.map((plan) => plan.checkoutPath)
						}

						const completed: typeof removalPlans = []
						const removed = yield* Effect.gen(function* () {
							for (const plan of removalPlans) {
								const result = yield* fs.runCommand(
									[
										"git",
										"-C",
										plan.repositoryPath,
										"worktree",
										"remove",
										...(!plan.checkoutExists ? ["--force"] : []),
										plan.checkoutExists
											? plan.checkoutPath
											: plan.registeredPath,
									],
									{ captureOutput: true },
								)
								if (result.exitCode !== 0) {
									return yield* new WorktreeError({
										message: `Failed to remove worktree for '${plan.alias}': ${result.stderr}`,
									})
								}
								completed.push(plan)
							}
							if (codeDirectoryExists && (yield* fs.isDirectory(codePath))) {
								yield* fs.deleteDirectory(codePath)
							}
							return removalPlans
								.filter((plan) => plan.checkoutExists)
								.map((plan) => plan.checkoutPath)
						}).pipe(
							Effect.catchAll((cause) =>
								Effect.gen(function* () {
									const rolledBack: string[] = []
									const manualRecovery: string[] = []
									for (const plan of [...completed].reverse()) {
										if (!plan.checkoutExists) continue
										yield* fs.createDirectory(dirname(plan.checkoutPath))
										const command = plan.branch
											? [
													"git",
													"-C",
													plan.repositoryPath,
													"worktree",
													"add",
													plan.checkoutPath,
													plan.branch,
												]
											: [
													"git",
													"-C",
													plan.repositoryPath,
													"worktree",
													"add",
													"--detach",
													plan.checkoutPath,
													plan.head!,
												]
										const restored = yield* fs.runCommand(command, {
											captureOutput: true,
										})
										if (restored.exitCode === 0)
											rolledBack.push(plan.checkoutPath)
										else manualRecovery.push(`Restore ${plan.checkoutPath}`)
									}
									return yield* new WorktreeError({
										message: manualRecovery.length
											? "Worktree removal failed and requires manual recovery"
											: "Worktree removal failed; removed worktrees were restored",
										completed: completed.map((plan) => plan.checkoutPath),
										rolledBack,
										manualRecovery,
										cause,
									})
								}),
							),
						)
						return removed
					})
					return yield* options.lockHeld
						? removal
						: withWorktreeLocks(
								root,
								[{ taskId, ...(phaseId ? { phaseId } : {}) }],
								removal,
							)
				}),
		}),
	},
) {}
