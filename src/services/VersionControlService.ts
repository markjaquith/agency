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

export interface PullRequestDefaults {
	readonly title: string
	readonly body: string
}

interface RepositoryInspection {
	readonly kind: "bare" | "repository"
	readonly remote: string | null
}

export interface VersionControlBackend {
	readonly kind: VersionControlKind
	readonly cloneRepository: (
		source: string,
		destination: string,
	) => Effect.Effect<void, unknown, any>
	readonly initializeRepository: (
		path: string,
	) => Effect.Effect<void, unknown, any>
	readonly inspectRepository: (
		path: string,
	) => Effect.Effect<RepositoryInspection | null, unknown, any>
	readonly gitEnvironment: (
		path: string,
	) => Effect.Effect<Record<string, string>, unknown, any>
	readonly pullRequestDefaults: (
		workspacePath: string,
		base: string,
	) => Effect.Effect<PullRequestDefaults | null, unknown, any>
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
	readonly importGitRefs: (
		repositoryPath: string,
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
	readonly setRemoteUrl: (
		repositoryPath: string,
		remote: string,
		url: string | null,
	) => Effect.Effect<void, unknown, any>
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
				cloneRepository: (source, destination) =>
					Effect.gen(function* () {
						const fs = yield* FileSystemService
						yield* requireSuccess(
							"Failed to clone Git repository",
							fs.runCommand(
								["git", "clone", "--bare", "--", source, destination],
								{
									captureOutput: true,
								},
							),
						)
					}),
				initializeRepository: () => Effect.void,
				inspectRepository: (path) =>
					Effect.gen(function* () {
						const fs = yield* FileSystemService
						const valid = yield* fs.runCommand(
							["git", "-C", path, "rev-parse", "--git-dir"],
							{ captureOutput: true },
						)
						if (valid.exitCode !== 0) return null
						const bare = yield* fs.runCommand(
							["git", "-C", path, "rev-parse", "--is-bare-repository"],
							{ captureOutput: true },
						)
						const remote = yield* fs.runCommand(
							["git", "-C", path, "remote", "get-url", "origin"],
							{ captureOutput: true },
						)
						return {
							kind: bare.stdout.trim() === "true" ? "bare" : "repository",
							remote: remote.exitCode === 0 ? remote.stdout.trim() : null,
						} as const
					}),
				gitEnvironment: () => Effect.succeed({}),
				pullRequestDefaults: () => Effect.succeed(null),
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
				importGitRefs: () => Effect.void,
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
				setRemoteUrl: (repositoryPath, remote, url) =>
					Effect.gen(function* () {
						const fs = yield* FileSystemService
						const previous = yield* fs.runCommand(
							["git", "-C", repositoryPath, "remote", "get-url", remote],
							{ captureOutput: true },
						)
						const command =
							url === null
								? ["git", "-C", repositoryPath, "remote", "remove", remote]
								: [
										"git",
										"-C",
										repositoryPath,
										"remote",
										previous.exitCode === 0 ? "set-url" : "add",
										remote,
										url,
									]
						yield* requireSuccess(
							`Failed to update Git remote '${remote}'`,
							fs.runCommand(command, { captureOutput: true }),
						)
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
				cloneRepository: (source, destination) =>
					Effect.gen(function* () {
						const fs = yield* FileSystemService
						yield* requireSuccess(
							"Failed to clone jj repository",
							fs.runCommand(
								[
									"jj",
									"git",
									"clone",
									"--no-colocate",
									"--",
									source,
									destination,
								],
								{ captureOutput: true },
							),
						)
					}),
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
				inspectRepository: (path) =>
					Effect.gen(function* () {
						const fs = yield* FileSystemService
						const root = yield* fs.runCommand(jjCommand(path, ["root"]), {
							captureOutput: true,
						})
						if (root.exitCode !== 0) return null
						const remote = yield* fs.runCommand(
							jjCommand(path, ["git", "remote", "list"]),
							{ captureOutput: true },
						)
						return {
							kind: "repository",
							remote:
								remote.exitCode === 0
									? (remote.stdout
											.split("\n")
											.find((line) => line.startsWith("origin "))
											?.slice("origin ".length)
											.trim() ?? null)
									: null,
						} as const
					}),
				gitEnvironment: (path) =>
					Effect.gen(function* () {
						const fs = yield* FileSystemService
						const result = yield* requireSuccess(
							"Failed to locate jj backing Git repository",
							fs.runCommand(jjCommand(path, ["git", "root"]), {
								captureOutput: true,
							}),
						)
						return { GIT_DIR: result.stdout.trim() }
					}),
				pullRequestDefaults: (workspacePath, base) =>
					Effect.gen(function* () {
						const fs = yield* FileSystemService
						const result = yield* fs.runCommand(
							jjCommand(workspacePath, [
								"log",
								"--ignore-working-copy",
								"--no-graph",
								"-r",
								`${base}..@-`,
								"-T",
								'description.first_line() ++ "\\n"',
							]),
							{ captureOutput: true },
						)
						if (result.exitCode !== 0) return null
						const commits = result.stdout
							.split("\n")
							.map((line) => line.trim())
							.filter(Boolean)
						if (commits.length === 0) return null
						return {
							title: commits.at(-1)!,
							body:
								commits.length === 1
									? ""
									: `Commits:\n${commits
											.toReversed()
											.map((commit) => `- ${commit}`)
											.join("\n")}`,
						} satisfies PullRequestDefaults
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
						const resolve = () =>
							fs.runCommand(
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
						let result = yield* resolve()
						if (result.exitCode !== 0 || !result.stdout.trim()) {
							const imported = yield* fs.runCommand(
								jjCommand(repositoryPath, ["git", "import"]),
								{ captureOutput: true },
							)
							if (imported.exitCode === 0) result = yield* resolve()
						}
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
				importGitRefs: (repositoryPath) =>
					Effect.gen(function* () {
						const fs = yield* FileSystemService
						yield* requireSuccess(
							"Failed to import Git refs into jj",
							fs.runCommand(jjCommand(repositoryPath, ["git", "import"]), {
								captureOutput: true,
							}),
						)
					}),
				push: (workspacePath, remote, branch) =>
					Effect.gen(function* () {
						const fs = yield* FileSystemService
						yield* requireSuccess(
							"Failed to set jj delivery bookmark",
							fs.runCommand(
								jjCommand(workspacePath, [
									"bookmark",
									"set",
									"--allow-backwards",
									branch,
									"-r",
									"@-",
								]),
								{ captureOutput: true },
							),
						)
						yield* requireSuccess(
							"Failed to push branch",
							fs.runCommand(
								jjCommand(workspacePath, [
									"git",
									"push",
									"--remote",
									remote,
									"--bookmark",
									branch,
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
				setRemoteUrl: (repositoryPath, remote, url) =>
					Effect.gen(function* () {
						const fs = yield* FileSystemService
						const previous = yield* fs.runCommand(
							jjCommand(repositoryPath, ["git", "remote", "list"]),
							{ captureOutput: true },
						)
						const exists = previous.stdout
							.split("\n")
							.some((line) => line.startsWith(`${remote} `))
						const args =
							url === null
								? ["git", "remote", "remove", remote]
								: ["git", "remote", exists ? "set-url" : "add", remote, url]
						yield* requireSuccess(
							`Failed to update jj Git remote '${remote}'`,
							fs.runCommand(jjCommand(repositoryPath, args), {
								captureOutput: true,
							}),
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
