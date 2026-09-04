import { Data, Effect } from "effect"
import { FileSystemService } from "./FileSystemService"

export interface RegisteredWorkspace {
	readonly name: string | null
	readonly path: string
	readonly commit: string | null
	readonly branch: string | null
	readonly head?: string | null
	readonly dirty?: boolean
}

interface RepositoryInspection {
	readonly kind: "bare" | "repository"
	readonly remote: string | null
}

export interface VersionControlBackend {
	readonly kind: "git"
	readonly cloneRepository: (
		source: string,
		destination: string,
	) => Effect.Effect<void, unknown, any>
	readonly inspectRepository: (
		path: string,
	) => Effect.Effect<RepositoryInspection | null, unknown, any>
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

interface GitConfigEntry {
	readonly scope: string
	readonly key: string
	readonly value: string
}

const parseGitConfig = (output: string): readonly GitConfigEntry[] =>
	output
		.trim()
		.split("\n")
		.filter(Boolean)
		.flatMap((line) => {
			const scopeSeparator = line.indexOf("\t")
			const valueSeparator = line.indexOf(" ", scopeSeparator + 1)
			return scopeSeparator >= 0 && valueSeparator >= 0
				? [
						{
							scope: line.slice(0, scopeSeparator),
							key: line.slice(scopeSeparator + 1, valueSeparator),
							value: line.slice(valueSeparator + 1),
						},
					]
				: []
		})

const expandGitUrl = (
	url: string,
	entries: readonly GitConfigEntry[],
): string => {
	let replacement: { readonly prefix: string; readonly base: string } | null =
		null
	for (const entry of entries) {
		const match = /^url\.(.*)\.insteadof$/i.exec(entry.key)
		if (
			match?.[1] !== undefined &&
			url.startsWith(entry.value) &&
			(replacement === null || entry.value.length > replacement.prefix.length)
		) {
			replacement = { prefix: entry.value, base: match[1] }
		}
	}
	return replacement === null
		? url
		: replacement.base + url.slice(replacement.prefix.length)
}

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
								[
									"git",
									"clone",
									"--bare",
									"--no-hardlinks",
									"--",
									source,
									destination,
								],
								{
									captureOutput: true,
								},
							),
						)
					}),
				inspectRepository: (path) =>
					Effect.gen(function* () {
						const fs = yield* FileSystemService
						const inspection = yield* fs.runCommand(
							[
								"git",
								"-C",
								path,
								"config",
								"--show-scope",
								"--get-regexp",
								"^(core\\.bare|remote\\.origin\\.url|url\\..*\\.insteadof)$",
							],
							{ captureOutput: true },
						)
						if (inspection.exitCode !== 0) return null
						const entries = parseGitConfig(inspection.stdout)
						const bare = entries.find(
							(entry) =>
								(entry.scope === "local" || entry.scope === "worktree") &&
								entry.key === "core.bare",
						)
						if (!bare) return null
						const remote = entries.find(
							(entry) => entry.key === "remote.origin.url",
						)?.value
						return {
							kind: bare.value === "true" ? "bare" : "repository",
							remote:
								remote === undefined ? null : expandGitUrl(remote, entries),
						} as const
					}),
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

export class VersionControlService extends Effect.Service<VersionControlService>()(
	"VersionControlService",
	{
		sync: () => ({
			forWorkbase: (_root: string) =>
				Effect.gen(function* () {
					return yield* GitVersionControlService
				}),
		}),
	},
) {}
