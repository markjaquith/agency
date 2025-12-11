/**
 * GitService implementation using isomorphic-git instead of spawning processes.
 * This is significantly faster for tests since it avoids process overhead.
 */
import { Effect, Data, pipe } from "effect"
import { resolve } from "path"
import { realpath } from "fs/promises"
import * as git from "isomorphic-git"
import * as fs from "node:fs"

// Error types for Git operations (same as GitService)
class GitError extends Data.TaggedError("GitError")<{
	message: string
	cause?: unknown
}> {}

class NotInGitRepoError extends Data.TaggedError("NotInGitRepoError")<{
	path: string
}> {}

export class GitCommandError extends Data.TaggedError("GitCommandError")<{
	command: string
	exitCode: number
	stderr: string
}> {}

// Default author/committer for commits (used in tests)
const DEFAULT_AUTHOR = {
	name: "Test User",
	email: "test@example.com",
}

// Helper to wrap isomorphic-git errors
const wrapGitError = <T>(
	operation: string,
	promise: Promise<T>,
): Effect.Effect<T, GitError> =>
	Effect.tryPromise({
		try: () => promise,
		catch: (error) =>
			new GitError({
				message: `${operation} failed: ${error instanceof Error ? error.message : String(error)}`,
				cause: error,
			}),
	})

// Git Service using isomorphic-git
export class IsomorphicGitService extends Effect.Service<IsomorphicGitService>()(
	"GitService",
	{
		sync: () => ({
			isInsideGitRepo: (path: string) =>
				pipe(
					Effect.tryPromise({
						try: () => git.findRoot({ fs, filepath: path }),
						catch: () => null,
					}),
					Effect.map((root) => root !== null),
					Effect.catchAll(() => Effect.succeed(false)),
				),

			getGitRoot: (path: string) =>
				pipe(
					Effect.tryPromise({
						try: () => git.findRoot({ fs, filepath: path }),
						catch: () => new NotInGitRepoError({ path }),
					}),
					Effect.mapError(() => new NotInGitRepoError({ path })),
				),

			isGitRoot: (path: string) =>
				Effect.gen(function* () {
					const absolutePath = yield* Effect.tryPromise({
						try: () => realpath(resolve(path)),
						catch: () =>
							new GitError({ message: "Failed to check if git root" }),
					})

					const gitRoot = yield* pipe(
						Effect.tryPromise({
							try: () => git.findRoot({ fs, filepath: absolutePath }),
							catch: () => null,
						}),
						Effect.catchAll(() => Effect.succeed(null)),
					)

					if (!gitRoot) return false

					const gitRootReal = yield* Effect.tryPromise({
						try: () => realpath(gitRoot),
						catch: () =>
							new GitError({ message: "Failed to check if git root" }),
					})

					return gitRootReal === absolutePath
				}),

			getGitConfig: (key: string, gitRoot: string) =>
				pipe(
					Effect.tryPromise({
						try: () => git.getConfig({ fs, dir: gitRoot, path: key }),
						catch: () => null,
					}),
					Effect.map((value) => (value !== undefined ? String(value) : null)),
					Effect.catchAll(() => Effect.succeed(null)),
				),

			setGitConfig: (key: string, value: string, gitRoot: string) =>
				pipe(
					wrapGitError(
						`setConfig(${key})`,
						git.setConfig({ fs, dir: gitRoot, path: key, value }),
					),
					Effect.asVoid,
				),

			getCurrentBranch: (gitRoot: string) =>
				pipe(
					Effect.tryPromise({
						try: () => git.currentBranch({ fs, dir: gitRoot, fullname: false }),
						catch: (error) =>
							new GitError({
								message: `Failed to get current branch: ${error}`,
							}),
					}),
					Effect.flatMap((branch) =>
						branch
							? Effect.succeed(branch)
							: Effect.fail(
									new GitError({
										message: "Not on any branch (detached HEAD)",
									}),
								),
					),
				),

			branchExists: (gitRoot: string, branch: string) =>
				Effect.gen(function* () {
					// Check local branches
					const localBranches = yield* Effect.tryPromise({
						try: () => git.listBranches({ fs, dir: gitRoot }),
						catch: () => [] as string[],
					})

					if (localBranches.includes(branch)) {
						return true
					}

					// Check remote branches
					const remotes = yield* Effect.tryPromise({
						try: () => git.listRemotes({ fs, dir: gitRoot }),
						catch: () => [] as { remote: string; url: string }[],
					})

					for (const { remote } of remotes) {
						if (branch.startsWith(`${remote}/`)) {
							const remoteBranches = yield* Effect.tryPromise({
								try: () => git.listBranches({ fs, dir: gitRoot, remote }),
								catch: () => [] as string[],
							})
							const branchName = branch.slice(remote.length + 1)
							if (remoteBranches.includes(branchName)) {
								return true
							}
						}
					}

					return false
				}).pipe(
					Effect.mapError(
						() =>
							new GitError({
								message: `Failed to check if branch exists: ${branch}`,
							}),
					),
				),

			createBranch: (
				branchName: string,
				gitRoot: string,
				baseBranch?: string,
			) =>
				Effect.gen(function* () {
					// Create the branch
					yield* wrapGitError(
						"branch",
						git.branch({
							fs,
							dir: gitRoot,
							ref: branchName,
							object: baseBranch,
							checkout: false, // Don't checkout yet
						}),
					)
					// Explicitly checkout to update working tree
					yield* wrapGitError(
						"checkout",
						git.checkout({ fs, dir: gitRoot, ref: branchName }),
					)
				}).pipe(Effect.asVoid),

			checkoutBranch: (gitRoot: string, branch: string) =>
				pipe(
					wrapGitError(
						"checkout",
						git.checkout({ fs, dir: gitRoot, ref: branch }),
					),
					Effect.asVoid,
				),

			gitAdd: (files: readonly string[], gitRoot: string) =>
				Effect.gen(function* () {
					for (const file of files) {
						yield* wrapGitError(
							`add(${file})`,
							git.add({ fs, dir: gitRoot, filepath: file }),
						)
					}
				}).pipe(Effect.asVoid),

			gitCommit: (
				message: string,
				gitRoot: string,
				_options?: { readonly noVerify?: boolean },
			) =>
				pipe(
					wrapGitError(
						"commit",
						git.commit({
							fs,
							dir: gitRoot,
							message,
							author: DEFAULT_AUTHOR,
						}),
					),
					Effect.asVoid,
				),

			getDefaultRemoteBranch: (gitRoot: string) =>
				Effect.gen(function* () {
					const remotes = yield* Effect.tryPromise({
						try: () => git.listRemotes({ fs, dir: gitRoot }),
						catch: () => [] as { remote: string; url: string }[],
					})

					if (remotes.length === 0) return null

					// Try remotes in order of preference
					let remote: string | null = null
					if (remotes.some((r) => r.remote === "origin")) {
						remote = "origin"
					} else if (remotes.some((r) => r.remote === "upstream")) {
						remote = "upstream"
					} else {
						remote = remotes[0]?.remote || null
					}

					if (!remote) return null

					// Try to get HEAD ref for this remote
					// Note: We don't use config here but keeping for potential future use
					yield* Effect.tryPromise({
						try: () =>
							git.getConfig({
								fs,
								dir: gitRoot,
								path: `remote.${remote}.fetch`,
							}),
						catch: () => null,
					})

					// Try to determine default branch from remote branches
					const remoteBranches = yield* Effect.tryPromise({
						try: () => git.listBranches({ fs, dir: gitRoot, remote }),
						catch: () => [] as string[],
					})

					// Common default branch names
					for (const branch of ["main", "master"]) {
						if (remoteBranches.includes(branch)) {
							return `${remote}/${branch}`
						}
					}

					return remoteBranches[0] ? `${remote}/${remoteBranches[0]}` : null
				}).pipe(Effect.catchAll(() => Effect.succeed(null))),

			findMainBranch: (gitRoot: string) =>
				Effect.gen(function* () {
					// Check local branches for common main branch names
					const branches = yield* Effect.tryPromise({
						try: () => git.listBranches({ fs, dir: gitRoot }),
						catch: () => [] as string[],
					})

					for (const branch of ["main", "master"]) {
						if (branches.includes(branch)) {
							return branch
						}
					}

					return null
				}).pipe(
					Effect.mapError(
						() => new GitError({ message: "Failed to find main branch" }),
					),
				),

			getSuggestedBaseBranches: (gitRoot: string) =>
				Effect.gen(function* () {
					const suggestions: string[] = []

					const branches = yield* Effect.tryPromise({
						try: () => git.listBranches({ fs, dir: gitRoot }),
						catch: () => [] as string[],
					})

					// Add common base branches if they exist
					for (const branch of [
						"main",
						"master",
						"develop",
						"development",
						"staging",
					]) {
						if (branches.includes(branch)) {
							suggestions.push(branch)
						}
					}

					// Add current branch
					const currentBranch = yield* Effect.tryPromise({
						try: () => git.currentBranch({ fs, dir: gitRoot, fullname: false }),
						catch: () => null,
					})

					if (currentBranch && !suggestions.includes(currentBranch)) {
						suggestions.push(currentBranch)
					}

					return suggestions as readonly string[]
				}).pipe(
					Effect.mapError(
						() =>
							new GitError({
								message: "Failed to get suggested base branches",
							}),
					),
				),

			isFeatureBranch: (currentBranch: string, gitRoot: string) =>
				Effect.gen(function* () {
					// Get configured main branch
					const configBranch = yield* Effect.tryPromise({
						try: () =>
							git.getConfig({ fs, dir: gitRoot, path: "agency.mainBranch" }),
						catch: () => undefined,
					})

					if (configBranch) {
						return currentBranch !== String(configBranch)
					}

					// Try to find main branch
					const branches = yield* Effect.tryPromise({
						try: () => git.listBranches({ fs, dir: gitRoot }),
						catch: () => [] as string[],
					})

					for (const branch of ["main", "master"]) {
						if (branches.includes(branch)) {
							return currentBranch !== branch
						}
					}

					// If we can't determine a main branch, assume current is a feature branch
					return true
				}).pipe(
					Effect.mapError(
						() =>
							new GitError({ message: "Failed to check if feature branch" }),
					),
				),

			getMainBranchConfig: (gitRoot: string) =>
				pipe(
					Effect.tryPromise({
						try: () =>
							git.getConfig({ fs, dir: gitRoot, path: "agency.mainBranch" }),
						catch: () => undefined,
					}),
					Effect.map((value) => (value !== undefined ? String(value) : null)),
					Effect.mapError(
						() => new GitError({ message: "Failed to get main branch config" }),
					),
				),

			setMainBranchConfig: (mainBranch: string, gitRoot: string) =>
				pipe(
					wrapGitError(
						"setConfig(agency.mainBranch)",
						git.setConfig({
							fs,
							dir: gitRoot,
							path: "agency.mainBranch",
							value: mainBranch,
						}),
					),
					Effect.asVoid,
				),

			getDefaultBaseBranchConfig: (gitRoot: string) =>
				pipe(
					Effect.tryPromise({
						try: () =>
							git.getConfig({ fs, dir: gitRoot, path: "agency.baseBranch" }),
						catch: () => undefined,
					}),
					Effect.map((value) => (value !== undefined ? String(value) : null)),
					Effect.mapError(
						() => new GitError({ message: "Failed to get base branch config" }),
					),
				),

			setDefaultBaseBranchConfig: (baseBranch: string, gitRoot: string) =>
				pipe(
					wrapGitError(
						"setConfig(agency.baseBranch)",
						git.setConfig({
							fs,
							dir: gitRoot,
							path: "agency.baseBranch",
							value: baseBranch,
						}),
					),
					Effect.asVoid,
				),

			findDefaultRemote: (gitRoot: string) =>
				Effect.gen(function* () {
					const remotes = yield* Effect.tryPromise({
						try: () => git.listRemotes({ fs, dir: gitRoot }),
						catch: () => [] as { remote: string; url: string }[],
					})

					if (remotes.length === 0) return null

					if (remotes.some((r) => r.remote === "origin")) return "origin"
					if (remotes.some((r) => r.remote === "upstream")) return "upstream"

					return remotes[0]?.remote || null
				}).pipe(
					Effect.mapError(
						() => new GitError({ message: "Failed to find default remote" }),
					),
				),

			getRemoteConfig: (gitRoot: string) =>
				pipe(
					Effect.tryPromise({
						try: () =>
							git.getConfig({ fs, dir: gitRoot, path: "agency.remote" }),
						catch: () => undefined,
					}),
					Effect.map((value) => (value !== undefined ? String(value) : null)),
					Effect.mapError(
						() => new GitError({ message: "Failed to get remote config" }),
					),
				),

			setRemoteConfig: (remote: string, gitRoot: string) =>
				pipe(
					wrapGitError(
						"setConfig(agency.remote)",
						git.setConfig({
							fs,
							dir: gitRoot,
							path: "agency.remote",
							value: remote,
						}),
					),
					Effect.asVoid,
				),

			getAllRemotes: (gitRoot: string) =>
				pipe(
					Effect.tryPromise({
						try: () => git.listRemotes({ fs, dir: gitRoot }),
						catch: () => [] as { remote: string; url: string }[],
					}),
					Effect.map(
						(remotes) => remotes.map((r) => r.remote) as readonly string[],
					),
					Effect.mapError(
						() => new GitError({ message: "Failed to get list of remotes" }),
					),
				),

			remoteExists: (gitRoot: string, remoteName: string) =>
				pipe(
					Effect.tryPromise({
						try: () => git.listRemotes({ fs, dir: gitRoot }),
						catch: () => [] as { remote: string; url: string }[],
					}),
					Effect.map((remotes) => remotes.some((r) => r.remote === remoteName)),
					Effect.mapError(
						() =>
							new GitError({
								message: `Failed to check if remote ${remoteName} exists`,
							}),
					),
				),

			getRemoteUrl: (gitRoot: string, remoteName: string) =>
				pipe(
					Effect.tryPromise({
						try: () => git.listRemotes({ fs, dir: gitRoot }),
						catch: () => [] as { remote: string; url: string }[],
					}),
					Effect.flatMap((remotes) => {
						const remote = remotes.find((r) => r.remote === remoteName)
						return remote
							? Effect.succeed(remote.url)
							: Effect.fail(
									new GitError({
										message: `Remote ${remoteName} not found`,
									}),
								)
					}),
				),

			resolveRemote: (gitRoot: string, providedRemote?: string) =>
				Effect.gen(function* () {
					const remotes = yield* Effect.tryPromise({
						try: () => git.listRemotes({ fs, dir: gitRoot }),
						catch: () => [] as { remote: string; url: string }[],
					})

					// If explicitly provided, validate and use it
					if (providedRemote) {
						if (!remotes.some((r) => r.remote === providedRemote)) {
							return yield* Effect.fail(
								new GitError({
									message: `Remote '${providedRemote}' does not exist`,
								}),
							)
						}
						return providedRemote
					}

					// Check for saved configuration
					const configRemote = yield* Effect.tryPromise({
						try: () =>
							git.getConfig({ fs, dir: gitRoot, path: "agency.remote" }),
						catch: () => undefined,
					})

					if (configRemote) {
						return String(configRemote)
					}

					// Auto-detect with smart precedence
					if (remotes.length === 0) {
						return yield* Effect.fail(
							new GitError({
								message:
									"No git remotes found. Add a remote with: git remote add <name> <url>",
							}),
						)
					}

					if (remotes.length === 1) {
						return remotes[0]!.remote
					}

					if (remotes.some((r) => r.remote === "origin")) return "origin"
					if (remotes.some((r) => r.remote === "upstream")) return "upstream"

					return remotes[0]!.remote
				}).pipe(
					Effect.mapError((error) =>
						error instanceof GitError
							? error
							: new GitError({
									message: "Failed to resolve remote",
									cause: error,
								}),
					),
				),

			stripRemotePrefix: (branchName: string) => {
				const match = branchName.match(/^[^/]+\/(.+)$/)
				return match?.[1] || branchName
			},

			hasRemotePrefix: (branchName: string, gitRoot: string) =>
				Effect.gen(function* () {
					const remotes = yield* Effect.tryPromise({
						try: () => git.listRemotes({ fs, dir: gitRoot }),
						catch: () => [] as { remote: string; url: string }[],
					})
					return remotes.some((r) => branchName.startsWith(`${r.remote}/`))
				}).pipe(
					Effect.mapError(
						() =>
							new GitError({
								message: `Failed to check if branch has remote prefix: ${branchName}`,
							}),
					),
				),

			getRemoteFromBranch: (branchName: string, gitRoot: string) =>
				Effect.gen(function* () {
					const remotes = yield* Effect.tryPromise({
						try: () => git.listRemotes({ fs, dir: gitRoot }),
						catch: () => [] as { remote: string; url: string }[],
					})

					for (const { remote } of remotes) {
						if (branchName.startsWith(`${remote}/`)) {
							return remote
						}
					}

					return null
				}).pipe(
					Effect.mapError(
						() =>
							new GitError({
								message: `Failed to get remote from branch: ${branchName}`,
							}),
					),
				),

			getDefaultBranchForRemote: (gitRoot: string, remoteName: string) =>
				Effect.gen(function* () {
					const remoteBranches = yield* Effect.tryPromise({
						try: () =>
							git.listBranches({ fs, dir: gitRoot, remote: remoteName }),
						catch: () => [] as string[],
					})

					for (const branch of ["main", "master", "HEAD"]) {
						if (remoteBranches.includes(branch)) {
							return `${remoteName}/${branch}`
						}
					}

					return remoteBranches[0] ? `${remoteName}/${remoteBranches[0]}` : null
				}).pipe(Effect.catchAll(() => Effect.succeed(null))),

			getMergeBase: (gitRoot: string, branch1: string, branch2: string) =>
				// Fall back to spawning git for merge-base (more reliable)
				pipe(
					Effect.tryPromise({
						try: async () => {
							const proc = Bun.spawn(["git", "merge-base", branch1, branch2], {
								cwd: gitRoot,
								stdout: "pipe",
								stderr: "pipe",
							})
							await proc.exited
							if (proc.exitCode !== 0) {
								const stderr = await new Response(proc.stderr).text()
								throw new Error(stderr)
							}
							const stdout = await new Response(proc.stdout).text()
							return stdout.trim()
						},
						catch: (error) =>
							new GitCommandError({
								command: `git merge-base ${branch1} ${branch2}`,
								exitCode: 1,
								stderr: String(error),
							}),
					}),
				),

			getMergeBaseForkPoint: (
				gitRoot: string,
				baseBranch: string,
				featureBranch: string,
			) =>
				// Fall back to spawning git for fork-point
				pipe(
					Effect.tryPromise({
						try: async () => {
							const proc = Bun.spawn(
								[
									"git",
									"merge-base",
									"--fork-point",
									baseBranch,
									featureBranch,
								],
								{
									cwd: gitRoot,
									stdout: "pipe",
									stderr: "pipe",
								},
							)
							await proc.exited
							if (proc.exitCode !== 0) {
								// fork-point can fail, fall back to regular merge-base
								const proc2 = Bun.spawn(
									["git", "merge-base", baseBranch, featureBranch],
									{
										cwd: gitRoot,
										stdout: "pipe",
										stderr: "pipe",
									},
								)
								await proc2.exited
								const stdout = await new Response(proc2.stdout).text()
								return stdout.trim()
							}
							const stdout = await new Response(proc.stdout).text()
							return stdout.trim()
						},
						catch: (error) =>
							new GitCommandError({
								command: `git merge-base --fork-point ${baseBranch} ${featureBranch}`,
								exitCode: 1,
								stderr: String(error),
							}),
					}),
				),

			deleteBranch: (gitRoot: string, branchName: string, _force = false) =>
				pipe(
					wrapGitError(
						"deleteBranch",
						git.deleteBranch({ fs, dir: gitRoot, ref: branchName }),
					),
					Effect.asVoid,
				),

			unsetGitConfig: (key: string, gitRoot: string) =>
				pipe(
					Effect.tryPromise({
						try: () =>
							git.setConfig({
								fs,
								dir: gitRoot,
								path: key,
								value: undefined as any,
							}),
						catch: () => null,
					}),
					Effect.asVoid,
					Effect.mapError(
						() => new GitError({ message: `Failed to unset config ${key}` }),
					),
				),

			checkCommandExists: (command: string) =>
				// For isomorphic-git, check if the command exists on the system
				// This is used to check for git-filter-repo, etc.
				pipe(
					Effect.tryPromise({
						try: async () => {
							const proc = Bun.spawn(["which", command], {
								stdout: "pipe",
								stderr: "pipe",
							})
							await proc.exited
							return proc.exitCode === 0
						},
						catch: () => false,
					}),
					Effect.catchAll(() => Effect.succeed(false)),
				),

			runGitCommand: (
				args: readonly string[],
				gitRoot: string,
				options?: {
					readonly env?: Record<string, string>
					readonly stdin?: string
					readonly captureOutput?: boolean
				},
			) =>
				Effect.gen(function* () {
					// Handle specific git commands that we can implement with isomorphic-git
					// git show <ref>:<path> - read file at ref
					if (
						args[0] === "git" &&
						args[1] === "show" &&
						args[2]?.includes(":")
					) {
						const [ref, filepath] = args[2].split(":")
						if (ref && filepath) {
							const oid = yield* Effect.tryPromise({
								try: () => git.resolveRef({ fs, dir: gitRoot, ref }),
								catch: () => new Error(`Could not resolve ref: ${ref}`),
							})

							const { blob } = yield* Effect.tryPromise({
								try: () => git.readBlob({ fs, dir: gitRoot, oid, filepath }),
								catch: () => new Error(`Could not read ${filepath} at ${ref}`),
							})

							return {
								exitCode: 0,
								stdout: new TextDecoder().decode(blob),
								stderr: "",
							}
						}
					}

					// git branch --format=... - list branches (only if not --merged)
					// If --merged is present, let it fall through to git process
					if (
						args[0] === "git" &&
						args[1] === "branch" &&
						args.some((a) => a.startsWith("--format=")) &&
						!args.some((a) => a === "--merged")
					) {
						const branches = yield* Effect.tryPromise({
							try: () => git.listBranches({ fs, dir: gitRoot }),
							catch: () => [] as string[],
						})
						return {
							exitCode: 0,
							stdout: branches.join("\n"),
							stderr: "",
						}
					}

					// For other commands, fall back to spawning git process
					// This handles git filter-repo, complex merges, etc.
					const result = yield* Effect.tryPromise({
						try: async () => {
							const proc = Bun.spawn([...args], {
								cwd: gitRoot,
								stdout: options?.captureOutput ? "pipe" : "inherit",
								stderr: "pipe",
								env: options?.env
									? { ...process.env, ...options.env }
									: process.env,
							})

							await proc.exited

							const stdout = options?.captureOutput
								? await new Response(proc.stdout).text()
								: ""
							const stderr = await new Response(proc.stderr).text()

							return { exitCode: proc.exitCode || 0, stdout, stderr }
						},
						catch: (error) =>
							new GitCommandError({
								command: args.join(" "),
								exitCode: 1,
								stderr: String(error),
							}),
					})

					if (result.exitCode !== 0) {
						return yield* Effect.fail(
							new GitCommandError({
								command: args.join(" "),
								exitCode: result.exitCode,
								stderr: result.stderr.trim(),
							}),
						)
					}

					return {
						exitCode: 0,
						stdout: result.stdout.trim(),
						stderr: result.stderr.trim(),
					}
				}),

			fetch: (gitRoot: string, remote?: string, branch?: string) =>
				// Fall back to spawning git for fetch
				pipe(
					Effect.tryPromise({
						try: async () => {
							const args = ["git", "fetch"]
							if (remote) {
								args.push(remote)
								if (branch) {
									args.push(branch)
								}
							}
							const proc = Bun.spawn(args, {
								cwd: gitRoot,
								stdout: "pipe",
								stderr: "pipe",
							})
							await proc.exited
							// Don't fail on fetch errors - remote might not exist
						},
						catch: () => null,
					}),
					Effect.asVoid,
				),

			getCommitsBetween: (gitRoot: string, base: string, head: string) =>
				// Fall back to spawning git for rev-list (more reliable)
				Effect.tryPromise({
					try: async () => {
						const proc = Bun.spawn(
							["git", "rev-list", "--reverse", `${base}..${head}`],
							{
								cwd: gitRoot,
								stdout: "pipe",
								stderr: "pipe",
							},
						)
						await proc.exited
						const stdout = await new Response(proc.stdout).text()
						return stdout.trim()
					},
					catch: (error) =>
						new GitCommandError({
							command: `git rev-list --reverse ${base}..${head}`,
							exitCode: 1,
							stderr: String(error),
						}),
				}),

			cherryPick: (gitRoot: string, commit: string) =>
				// Fall back to spawning git for cherry-pick (not supported in isomorphic-git)
				pipe(
					Effect.tryPromise({
						try: async () => {
							const proc = Bun.spawn(["git", "cherry-pick", commit], {
								cwd: gitRoot,
								stdout: "pipe",
								stderr: "pipe",
							})
							await proc.exited
							if (proc.exitCode !== 0) {
								const stderr = await new Response(proc.stderr).text()
								throw new Error(stderr)
							}
						},
						catch: (error) =>
							new GitCommandError({
								command: `git cherry-pick ${commit}`,
								exitCode: 1,
								stderr: String(error),
							}),
					}),
					Effect.asVoid,
				),

			getRemoteTrackingBranch: (gitRoot: string, branch: string) =>
				Effect.gen(function* () {
					const remote = yield* Effect.tryPromise({
						try: () =>
							git.getConfig({
								fs,
								dir: gitRoot,
								path: `branch.${branch}.remote`,
							}),
						catch: () => undefined,
					})

					const merge = yield* Effect.tryPromise({
						try: () =>
							git.getConfig({
								fs,
								dir: gitRoot,
								path: `branch.${branch}.merge`,
							}),
						catch: () => undefined,
					})

					if (!remote || !merge) return null

					const branchName = String(merge).replace(/^refs\/heads\//, "")
					return `${remote}/${branchName}`
				}),

			getFileAtRef: (gitRoot: string, ref: string, filePath: string) =>
				pipe(
					Effect.tryPromise({
						try: async () => {
							// First resolve the ref to a commit SHA
							const oid = await git.resolveRef({ fs, dir: gitRoot, ref })

							// Then read the blob with the resolved OID
							const { blob } = await git.readBlob({
								fs,
								dir: gitRoot,
								oid,
								filepath: filePath,
							})

							return new TextDecoder().decode(blob)
						},
						catch: () => null,
					}),
					Effect.catchAll(() => Effect.succeed(null)),
				),
		}),
	},
) {}
