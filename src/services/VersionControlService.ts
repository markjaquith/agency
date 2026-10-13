import { Data, Effect, Context, Layer } from "effect"
import { FileSystemService } from "./FileSystemService"
import { integrateRemoteRemediation, reflogIncludes } from "./git-publication"

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
		options?: { readonly forceWithLease?: boolean },
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

const ignoredUntrackedGitPath = /^(?:.*\/)?\.DS_Store$/

export const isDirtyGitStatus = (output: string): boolean =>
	(output.includes("\0") ? output.split("\0") : output.split(/\r?\n/)).some(
		(line) => {
			if (!line) return false
			if (!line.startsWith("?? ")) return true
			return !ignoredUntrackedGitPath.test(line.slice(3))
		},
	)

class VersionControlError extends Data.TaggedError("VersionControlError")<{
	readonly message: string
}> {}

class PushRejectedError extends Data.TaggedError("PushRejectedError")<{
	readonly message: string
	readonly category: "remote_divergence"
	readonly protocolCode: "PUSH_REMOTE_DIVERGENCE"
	readonly retryable: false
	readonly remediation: string
	/** Whether local history rewrote the observed remote tip. */
	readonly rewritten: boolean
}> {}

const pushRejected = (
	message: string,
	rewritten: boolean,
	remediation: string,
) =>
	new PushRejectedError({
		message,
		category: "remote_divergence",
		protocolCode: "PUSH_REMOTE_DIVERGENCE",
		retryable: false,
		remediation,
		rewritten,
	})

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

export class GitVersionControlService extends Context.Service<GitVersionControlService>()(
	"GitVersionControlService",
	{
		make: Effect.sync(
			() =>
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
								[
									"git",
									"-C",
									workspacePath,
									"status",
									"--porcelain=v1",
									"-z",
									"--untracked-files=all",
								],
								{ captureOutput: true },
							)
							return result.exitCode === 0
								? isDirtyGitStatus(result.stdout)
								: null
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
					push: (workspacePath, remote, branch, options = {}) =>
						Effect.gen(function* () {
							const fs = yield* FileSystemService
							const tracking = yield* fs.runCommand(
								[
									"git",
									"-C",
									workspacePath,
									"rev-parse",
									"--verify",
									"--quiet",
									`refs/remotes/${remote}/${branch}^{commit}`,
								],
								{ captureOutput: true },
							)
							// The remote-tracking tip is what this checkout last observed
							// and is the lease for a force-push.
							const observed =
								tracking.exitCode === 0 ? tracking.stdout.trim() || null : null
							const integrate = integrateRemoteRemediation(remote, branch)
							if (
								options.forceWithLease &&
								observed &&
								(yield* reflogIncludes(fs, workspacePath, branch, observed)) ===
									false
							) {
								return yield* pushRejected(
									`Failed to push branch '${branch}': ${remote}/${branch} (${observed}) was fetched but never integrated into local history; refusing to force-push`,
									false,
									integrate,
								)
							}
							const pushed = yield* fs.runCommand(
								[
									"git",
									"-C",
									workspacePath,
									"push",
									"--set-upstream",
									...(options.forceWithLease
										? [
												`--force-with-lease=refs/heads/${branch}:${observed ?? ""}`,
											]
										: []),
									remote,
									branch,
								],
								{ captureOutput: true },
							)
							if (pushed.exitCode === 0) return
							const output = pushed.stderr.trim() || pushed.stdout.trim()
							if (
								!/non-fast-forward|fetch first|stale info|incorrect old value provided/.test(
									output,
								)
							) {
								return yield* new VersionControlError({
									message: `Failed to push branch: ${output}`,
								})
							}
							const listed = yield* fs.runCommand(
								[
									"git",
									"-C",
									workspacePath,
									"ls-remote",
									"--heads",
									remote,
									`refs/heads/${branch}`,
								],
								{ captureOutput: true },
							)
							const remoteTip =
								listed.exitCode === 0
									? listed.stdout.split(/\s+/, 1)[0] || null
									: null
							const rewritten =
								!options.forceWithLease &&
								remoteTip !== null &&
								remoteTip === observed &&
								(yield* reflogIncludes(
									fs,
									workspacePath,
									branch,
									remoteTip,
								)) !== false
							if (rewritten) {
								return yield* pushRejected(
									`Failed to push branch '${branch}': local history was rewritten over ${remote}/${branch} (${remoteTip}); refusing a non-fast-forward update without --force-with-lease`,
									true,
									"Local history was intentionally rewritten (amend, rebase, or squash). Retry this Agency command with --force-with-lease. Do not use a raw git push.",
								)
							}
							return yield* pushRejected(
								`Failed to push branch '${branch}': ${remote}/${branch} ${
									observed && remoteTip !== observed
										? `moved from ${observed} to ${remoteTip ?? "a missing ref"} since this checkout last observed it`
										: "has commits not integrated into local history"
								}; refusing a non-fast-forward update`,
								false,
								integrate,
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
		),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}

export class VersionControlService extends Context.Service<VersionControlService>()(
	"VersionControlService",
	{
		make: Effect.sync(() => ({
			forWorkbase: (_root: string) =>
				Effect.gen(function* () {
					return yield* GitVersionControlService
				}),
		})),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
