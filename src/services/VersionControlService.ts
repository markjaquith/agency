import { Data, Effect } from "effect"
import { FileSystemService } from "./FileSystemService"
import { WorkbaseService } from "./WorkbaseService"
import type { VersionControlKind } from "../workbase/version-control"

export interface RegisteredWorkspace {
	readonly name: string | null
	readonly path: string
	readonly commit: string | null
	readonly branch: string | null
	readonly head?: string | null
	readonly dirty?: boolean
}

export interface VersionControlBackend {
	readonly kind: VersionControlKind
	readonly initializeRepository: (
		path: string,
	) => Effect.Effect<void, unknown, any>
	readonly listWorkspaces: (
		repositoryPath: string,
	) => Effect.Effect<readonly RegisteredWorkspace[], unknown, any>
	readonly resolveRevision: (
		repositoryPath: string,
		revision: string,
	) => Effect.Effect<string | null, unknown, any>
	readonly workspaceHead: (
		workspacePath: string,
	) => Effect.Effect<string | null, unknown, any>
	readonly workspaceDirty: (
		workspacePath: string,
	) => Effect.Effect<boolean | null, unknown, any>
	readonly createWorkspace: (options: {
		readonly repositoryPath: string
		readonly workspacePath: string
		readonly workspaceName: string
		readonly revision: string
		readonly branch?: string
	}) => Effect.Effect<void, unknown, any>
	readonly removeWorkspace: (options: {
		readonly repositoryPath: string
		readonly workspacePath: string
		readonly workspaceName: string | null
	}) => Effect.Effect<void, unknown, any>
	readonly fetch: (
		repositoryPath: string,
		remote?: string,
		branch?: string,
	) => Effect.Effect<void, unknown, any>
	readonly push: (
		workspacePath: string,
		remote: string,
		branch: string,
	) => Effect.Effect<void, unknown, any>
	readonly remoteUrl: (
		repositoryPath: string,
		remote: string,
	) => Effect.Effect<string | null, unknown, any>
}

class VersionControlError extends Data.TaggedError("VersionControlError")<{
	readonly message: string
}> {}

const requireSuccess = (
	label: string,
	effect: Effect.Effect<
		{
			readonly exitCode: number
			readonly stdout: string
			readonly stderr: string
		},
		unknown,
		any
	>,
) =>
	effect.pipe(
		Effect.flatMap((result) =>
			result.exitCode === 0
				? Effect.succeed(result)
				: Effect.fail(
						new VersionControlError({
							message: `${label}: ${result.stderr.trim() || result.stdout.trim()}`,
						}),
					),
		),
	)

const parseGitWorktrees = (output: string): readonly RegisteredWorkspace[] => {
	const workspaces: RegisteredWorkspace[] = []
	let current: RegisteredWorkspace | null = null
	for (const field of output.split("\0")) {
		if (field.startsWith("worktree ")) {
			if (current) workspaces.push(current)
			current = {
				name: null,
				path: field.slice("worktree ".length),
				commit: null,
				branch: null,
			}
		} else if (current && field.startsWith("HEAD ")) {
			const workspace: RegisteredWorkspace = current
			current = { ...workspace, commit: field.slice("HEAD ".length) }
		} else if (current && field.startsWith("branch ")) {
			const workspace: RegisteredWorkspace = current
			current = {
				...workspace,
				branch: field.slice("branch ".length),
			}
		}
	}
	if (current) workspaces.push(current)
	return workspaces
}

export class GitVersionControlService extends Effect.Service<GitVersionControlService>()(
	"GitVersionControlService",
	{
		sync: () =>
			({
				kind: "git",
				initializeRepository: () => Effect.void,
				listWorkspaces: (repositoryPath) =>
					Effect.gen(function* () {
						const fs = yield* FileSystemService
						const result = yield* requireSuccess(
							"Failed to inspect Git worktrees",
							fs.runCommand(
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
							),
						)
						return parseGitWorktrees(result.stdout)
					}),
				resolveRevision: (repositoryPath, revision) =>
					Effect.gen(function* () {
						const fs = yield* FileSystemService
						const result = yield* fs.runCommand(
							[
								"git",
								"-C",
								repositoryPath,
								"rev-parse",
								"--verify",
								`${revision}^{commit}`,
							],
							{ captureOutput: true },
						)
						return result.exitCode === 0 ? result.stdout.trim() : null
					}),
				workspaceHead: (workspacePath) =>
					Effect.gen(function* () {
						const fs = yield* FileSystemService
						const result = yield* fs.runCommand(
							["git", "-C", workspacePath, "rev-parse", "HEAD"],
							{ captureOutput: true },
						)
						return result.exitCode === 0 ? result.stdout.trim() : null
					}),
				workspaceDirty: (workspacePath) =>
					Effect.gen(function* () {
						const fs = yield* FileSystemService
						const result = yield* fs.runCommand(
							["git", "-C", workspacePath, "status", "--porcelain"],
							{ captureOutput: true },
						)
						return result.exitCode === 0 ? result.stdout.length > 0 : null
					}),
				createWorkspace: (options) =>
					Effect.gen(function* () {
						const fs = yield* FileSystemService
						const command = options.branch
							? [
									"git",
									"-C",
									options.repositoryPath,
									"worktree",
									"add",
									"-b",
									options.branch,
									options.workspacePath,
									options.revision,
								]
							: [
									"git",
									"-C",
									options.repositoryPath,
									"worktree",
									"add",
									"--detach",
									options.workspacePath,
									options.revision,
								]
						yield* requireSuccess(
							"Failed to create Git worktree",
							fs.runCommand(command, { captureOutput: true }),
						)
					}),
				removeWorkspace: (options) =>
					Effect.gen(function* () {
						const fs = yield* FileSystemService
						yield* requireSuccess(
							"Failed to remove Git worktree",
							fs.runCommand(
								[
									"git",
									"-C",
									options.repositoryPath,
									"worktree",
									"remove",
									options.workspacePath,
								],
								{ captureOutput: true },
							),
						)
					}),
				fetch: (repositoryPath, remote = "origin", branch) =>
					Effect.gen(function* () {
						const fs = yield* FileSystemService
						yield* requireSuccess(
							"Failed to fetch Git repository",
							fs.runCommand(
								[
									"git",
									"-C",
									repositoryPath,
									"fetch",
									remote,
									...(branch ? [branch] : []),
								],
								{ captureOutput: true },
							),
						)
					}),
				push: (workspacePath, remote, branch) =>
					Effect.gen(function* () {
						const fs = yield* FileSystemService
						yield* requireSuccess(
							"Failed to push branch",
							fs.runCommand(
								[
									"git",
									"-C",
									workspacePath,
									"push",
									"--set-upstream",
									remote,
									branch,
								],
								{ captureOutput: true },
							),
						)
					}),
				remoteUrl: (repositoryPath, remote) =>
					Effect.gen(function* () {
						const fs = yield* FileSystemService
						const result = yield* fs.runCommand(
							["git", "-C", repositoryPath, "remote", "get-url", remote],
							{ captureOutput: true },
						)
						return result.exitCode === 0 ? result.stdout.trim() : null
					}),
			}) satisfies VersionControlBackend,
	},
) {}

const jjCommand = (repositoryPath: string, args: readonly string[]) => [
	"jj",
	"-R",
	repositoryPath,
	"--no-pager",
	...args,
]

export class JjVersionControlService extends Effect.Service<JjVersionControlService>()(
	"JjVersionControlService",
	{
		sync: () =>
			({
				kind: "jj",
				initializeRepository: (path) =>
					Effect.gen(function* () {
						const fs = yield* FileSystemService
						if (yield* fs.exists(`${path}/.jj`)) return
						yield* requireSuccess(
							"Failed to initialize jj repository",
							fs.runCommand(["jj", "git", "init", "--colocate", path], {
								captureOutput: true,
							}),
						)
					}),
				listWorkspaces: (repositoryPath) =>
					Effect.gen(function* () {
						const fs = yield* FileSystemService
						const result = yield* requireSuccess(
							"Failed to inspect jj workspaces",
							fs.runCommand(
								jjCommand(repositoryPath, [
									"workspace",
									"list",
									"-T",
									'name ++ "\\t" ++ root ++ "\\t" ++ target.commit_id() ++ "\\t" ++ target.parents().map(|commit| commit.commit_id()).join(",") ++ "\\t" ++ target.empty() ++ "\\n"',
								]),
								{ captureOutput: true },
							),
						)
						return result.stdout
							.trim()
							.split("\n")
							.filter(Boolean)
							.map((line) => {
								const [name, path, commit, parents, empty] = line.split("\t")
								const parentCommits = parents?.split(",").filter(Boolean) ?? []
								return {
									name: name || null,
									path: path!,
									commit: commit || null,
									branch: null,
									head:
										parentCommits.length === 1 ? parentCommits[0]! : undefined,
									dirty: empty === "false",
								}
							})
					}),
				resolveRevision: (repositoryPath, revision) =>
					Effect.gen(function* () {
						const fs = yield* FileSystemService
						const result = yield* fs.runCommand(
							jjCommand(repositoryPath, [
								"log",
								"--ignore-working-copy",
								"--no-graph",
								"-r",
								revision,
								"-T",
								'commit_id ++ "\\n"',
							]),
							{ captureOutput: true },
						)
						return result.exitCode === 0 ? result.stdout.trim() || null : null
					}),
				workspaceHead: (workspacePath) =>
					Effect.gen(function* () {
						const fs = yield* FileSystemService
						const result = yield* fs.runCommand(
							jjCommand(workspacePath, [
								"log",
								"--ignore-working-copy",
								"--no-graph",
								"-r",
								"@-",
								"-T",
								'commit_id ++ "\\n"',
							]),
							{ captureOutput: true },
						)
						return result.exitCode === 0 ? result.stdout.trim() || null : null
					}),
				workspaceDirty: (workspacePath) =>
					Effect.gen(function* () {
						const fs = yield* FileSystemService
						const result = yield* fs.runCommand(
							jjCommand(workspacePath, ["diff", "--summary", "-r", "@"]),
							{ captureOutput: true },
						)
						return result.exitCode === 0 ? result.stdout.length > 0 : null
					}),
				createWorkspace: (options) =>
					Effect.gen(function* () {
						const fs = yield* FileSystemService
						yield* requireSuccess(
							"Failed to create jj workspace",
							fs.runCommand(
								jjCommand(options.repositoryPath, [
									"workspace",
									"add",
									"--name",
									options.workspaceName,
									"-r",
									options.revision,
									options.workspacePath,
								]),
								{ captureOutput: true },
							),
						)
					}),
				removeWorkspace: (options) =>
					Effect.gen(function* () {
						const fs = yield* FileSystemService
						if (!options.workspaceName) {
							return yield* new VersionControlError({
								message: `Cannot remove unregistered jj workspace ${options.workspacePath}`,
							})
						}
						yield* requireSuccess(
							"Failed to forget jj workspace",
							fs.runCommand(
								jjCommand(options.repositoryPath, [
									"workspace",
									"forget",
									options.workspaceName,
								]),
								{ captureOutput: true },
							),
						)
						yield* fs.deleteDirectory(options.workspacePath)
					}),
				fetch: (repositoryPath, remote = "origin", branch) =>
					Effect.gen(function* () {
						const fs = yield* FileSystemService
						yield* requireSuccess(
							"Failed to fetch jj repository",
							fs.runCommand(
								jjCommand(repositoryPath, [
									"git",
									"fetch",
									"--remote",
									remote,
									...(branch ? ["--branch", branch] : []),
								]),
								{ captureOutput: true },
							),
						)
					}),
				push: (workspacePath, remote, branch) =>
					Effect.gen(function* () {
						const fs = yield* FileSystemService
						yield* requireSuccess(
							"Failed to push branch",
							fs.runCommand(
								jjCommand(workspacePath, [
									"git",
									"push",
									"--remote",
									remote,
									"--named",
									`${branch}=@-`,
								]),
								{ captureOutput: true },
							),
						)
					}),
				remoteUrl: (repositoryPath, remote) =>
					Effect.gen(function* () {
						const fs = yield* FileSystemService
						const result = yield* fs.runCommand(
							jjCommand(repositoryPath, ["git", "remote", "list"]),
							{ captureOutput: true },
						)
						if (result.exitCode !== 0) return null
						return (
							result.stdout
								.split("\n")
								.find((line) => line.startsWith(`${remote} `))
								?.slice(remote.length + 1)
								.trim() ?? null
						)
					}),
			}) satisfies VersionControlBackend,
	},
) {}

export class VersionControlService extends Effect.Service<VersionControlService>()(
	"VersionControlService",
	{
		sync: () => ({
			forWorkbase: (root: string) =>
				Effect.gen(function* () {
					const workbase = yield* WorkbaseService
					const git = yield* GitVersionControlService
					const jj = yield* JjVersionControlService
					const { config } = yield* workbase.loadConfig(root)
					return config.vcs === "jj" ? jj : git
				}),
		}),
	},
) {}
