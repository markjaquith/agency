import { Effect, Data, pipe } from "effect"
import { resolve } from "path"
import { realpath } from "fs/promises"
import {
	spawnProcess,
	checkExitCodeAndReturnStdout,
	checkExitCodeAndReturnVoid,
	createErrorMapper,
} from "../utils/process"

// Error types for Git operations
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

// Error mapper for git command failures
const mapToGitCommandError = createErrorMapper(GitCommandError)

// Helper to run git commands with proper error handling
const runGitCommand = (args: readonly string[], cwd: string) =>
	pipe(
		spawnProcess(args, { cwd }),
		Effect.mapError(
			(processError) =>
				new GitCommandError({
					command: processError.command,
					exitCode: processError.exitCode,
					stderr: processError.stderr,
				}),
		),
	)

// Helper to run git commands and check exit code
const runGitCommandOrFail = (args: readonly string[], cwd: string) =>
	pipe(
		runGitCommand(args, cwd),
		Effect.flatMap(checkExitCodeAndReturnStdout(mapToGitCommandError(args))),
	)

// Helper to run git commands that return void
const runGitCommandVoid = (args: readonly string[], cwd: string) =>
	pipe(
		runGitCommand(args, cwd),
		Effect.flatMap(checkExitCodeAndReturnVoid(mapToGitCommandError(args))),
	)

// Helper to get git config value
const getGitConfigEffect = (key: string, gitRoot: string) =>
	pipe(
		runGitCommand(["git", "config", "--local", "--get", key], gitRoot),
		Effect.map((result) => (result.exitCode === 0 ? result.stdout : null)),
	)

// Helper to set git config value
const setGitConfigEffect = (key: string, value: string, gitRoot: string) =>
	pipe(
		runGitCommandVoid(["git", "config", "--local", key, value], gitRoot),
		Effect.mapError(
			(error) =>
				new GitError({
					message:
						error instanceof GitCommandError
							? `Failed to set git config ${key}: ${error.stderr}`
							: `Failed to set git config ${key}`,
					cause: error,
				}),
		),
	)

// Helper to check if branch exists
const branchExistsEffect = (gitRoot: string, branch: string) =>
	Effect.gen(function* () {
		// Get list of remotes to dynamically check if it's a remote branch
		const remotesResult = yield* runGitCommand(["git", "remote"], gitRoot)
		const remotes =
			remotesResult.exitCode === 0 && remotesResult.stdout.trim()
				? remotesResult.stdout.trim().split("\n")
				: []

		// Check if branch name starts with any remote prefix
		const hasRemotePrefix = remotes.some((remote) =>
			branch.startsWith(`${remote}/`),
		)

		const ref = hasRemotePrefix
			? `refs/remotes/${branch}`
			: `refs/heads/${branch}`

		const result = yield* runGitCommand(
			["git", "show-ref", "--verify", "--quiet", ref],
			gitRoot,
		)
		return result.exitCode === 0
	})

// Helper to find default remote
const findDefaultRemoteEffect = (gitRoot: string) =>
	Effect.gen(function* () {
		// Get list of remotes
		const result = yield* runGitCommand(["git", "remote"], gitRoot)

		if (result.exitCode === 0 && result.stdout.trim()) {
			// Return first remote (usually "origin")
			const remotes = result.stdout.trim().split("\n")
			return remotes[0] || null
		}

		return null
	})

// Helper to find main branch (shared logic)
const findMainBranchEffect = (gitRoot: string) =>
	Effect.gen(function* () {
		// Get list of remotes
		const remotesResult = yield* runGitCommand(["git", "remote"], gitRoot)
		const remotes =
			remotesResult.exitCode === 0 && remotesResult.stdout.trim()
				? remotesResult.stdout.trim().split("\n")
				: []

		// Try to resolve a remote (prefer origin > upstream > first)
		let defaultRemote: string | null = null
		if (remotes.length > 0) {
			if (remotes.includes("origin")) {
				defaultRemote = "origin"
			} else if (remotes.includes("upstream")) {
				defaultRemote = "upstream"
			} else {
				defaultRemote = remotes[0] || null
			}
		}

		// If we have a remote, check for remote/HEAD
		if (defaultRemote) {
			const remoteHeadResult = yield* runGitCommand(
				["git", "rev-parse", "--abbrev-ref", `${defaultRemote}/HEAD`],
				gitRoot,
			)

			if (remoteHeadResult.exitCode === 0) {
				const remoteHead = remoteHeadResult.stdout

				// Check if it exists
				const exists = yield* branchExistsEffect(gitRoot, remoteHead)
				if (exists) {
					// Strip the remote prefix if present
					const match = remoteHead.match(/^[^/]+\/(.+)$/)
					if (match?.[1]) {
						return match[1]
					}
					return remoteHead
				}
			}
		}

		// Try common base branches in order
		const commonBases = ["main", "master"]
		for (const base of commonBases) {
			const exists = yield* branchExistsEffect(gitRoot, base)
			if (exists) {
				return base
			}
		}

		return null
	})

// Git Service using Effect.Service pattern
export class GitService extends Effect.Service<GitService>()("GitService", {
	sync: () => ({
		isInsideGitRepo: (path: string) =>
			pipe(
				spawnProcess(["git", "rev-parse", "--is-inside-work-tree"], {
					cwd: path,
				}),
				Effect.map((result) => result.exitCode === 0),
				Effect.mapError(
					() => new GitError({ message: "Failed to check git repo status" }),
				),
			),

		getGitRoot: (path: string) =>
			pipe(
				spawnProcess(["git", "rev-parse", "--show-toplevel"], { cwd: path }),
				Effect.flatMap((result) =>
					result.exitCode === 0
						? Effect.succeed(result.stdout)
						: Effect.fail(new NotInGitRepoError({ path })),
				),
				Effect.mapError(() => new NotInGitRepoError({ path })),
			),

		isGitRoot: (path: string) =>
			Effect.gen(function* () {
				const absolutePath = yield* Effect.tryPromise({
					try: () => realpath(resolve(path)),
					catch: () => new GitError({ message: "Failed to check if git root" }),
				})

				const result = yield* pipe(
					spawnProcess(["git", "rev-parse", "--show-toplevel"], {
						cwd: absolutePath,
					}),
					Effect.mapError(
						() => new GitError({ message: "Failed to check if git root" }),
					),
				)

				if (result.exitCode !== 0) {
					return false
				}

				const gitRootReal = yield* Effect.tryPromise({
					try: () => realpath(result.stdout),
					catch: () => new GitError({ message: "Failed to check if git root" }),
				})

				return gitRootReal === absolutePath
			}),

		getGitConfig: (key: string, gitRoot: string) =>
			pipe(
				getGitConfigEffect(key, gitRoot),
				Effect.catchAll(() => Effect.succeed(null)),
			),

		setGitConfig: (key: string, value: string, gitRoot: string) =>
			setGitConfigEffect(key, value, gitRoot),

		getCurrentBranch: (gitRoot: string) =>
			runGitCommandOrFail(["git", "branch", "--show-current"], gitRoot),

		branchExists: (gitRoot: string, branch: string) =>
			pipe(
				branchExistsEffect(gitRoot, branch),
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
		) => {
			const args = ["git", "checkout", "-b", branchName]
			if (baseBranch) {
				args.push(baseBranch)
			}

			return runGitCommandVoid(args, gitRoot)
		},

		checkoutBranch: (gitRoot: string, branch: string) =>
			runGitCommandVoid(["git", "checkout", branch], gitRoot),

		gitAdd: (files: readonly string[], gitRoot: string) =>
			runGitCommandVoid(["git", "add", ...files], gitRoot),

		gitCommit: (
			message: string,
			gitRoot: string,
			options?: { readonly noVerify?: boolean },
		) => {
			const args = ["git", "commit", "-m", message]
			if (options?.noVerify) {
				args.push("--no-verify")
			}

			return runGitCommandVoid(args, gitRoot)
		},

		getDefaultRemoteBranch: (gitRoot: string) =>
			Effect.gen(function* () {
				// Get list of remotes
				const remotesResult = yield* runGitCommand(["git", "remote"], gitRoot)
				const remotes =
					remotesResult.exitCode === 0 && remotesResult.stdout.trim()
						? remotesResult.stdout.trim().split("\n")
						: []

				if (remotes.length === 0) {
					return null
				}

				// Try remotes in order of preference: origin > upstream > first
				let remote: string
				if (remotes.includes("origin")) {
					remote = "origin"
				} else if (remotes.includes("upstream")) {
					remote = "upstream"
				} else {
					remote = remotes[0] || ""
				}

				if (!remote) {
					return null
				}

				const result = yield* runGitCommand(
					["git", "rev-parse", "--abbrev-ref", `${remote}/HEAD`],
					gitRoot,
				)

				return result.exitCode === 0 ? result.stdout : null
			}).pipe(Effect.catchAll(() => Effect.succeed(null))),

		findMainBranch: (gitRoot: string) =>
			pipe(
				findMainBranchEffect(gitRoot),
				Effect.mapError(
					() => new GitError({ message: "Failed to find main branch" }),
				),
			),

		getSuggestedBaseBranches: (gitRoot: string) =>
			Effect.gen(function* () {
				const suggestions: string[] = []

				// Get the main branch from config or find it
				const mainBranchFromConfig = yield* getGitConfigEffect(
					"agency.mainBranch",
					gitRoot,
				)
				const mainBranch =
					mainBranchFromConfig || (yield* findMainBranchEffect(gitRoot))

				if (mainBranch) {
					suggestions.push(mainBranch)
				}

				// Check for other common base branches
				const commonBases = ["develop", "development", "staging"]
				for (const base of commonBases) {
					const exists = yield* branchExistsEffect(gitRoot, base)
					if (exists && !suggestions.includes(base)) {
						suggestions.push(base)
					}
				}

				// Get current branch as a suggestion too
				const currentBranch = yield* runGitCommandOrFail(
					["git", "branch", "--show-current"],
					gitRoot,
				)
				if (currentBranch && !suggestions.includes(currentBranch)) {
					suggestions.push(currentBranch)
				}

				return suggestions as readonly string[]
			}).pipe(
				Effect.mapError(
					() =>
						new GitError({ message: "Failed to get suggested base branches" }),
				),
			),

		isFeatureBranch: (currentBranch: string, gitRoot: string) =>
			Effect.gen(function* () {
				// Get the main branch from config or find it
				const configBranch = yield* getGitConfigEffect(
					"agency.mainBranch",
					gitRoot,
				)
				const mainBranch =
					configBranch || (yield* findMainBranchEffect(gitRoot))

				// If we couldn't determine a main branch, assume current is a feature branch
				if (!mainBranch) {
					return true
				}

				// Save it for future use if we found it and it wasn't in config
				if (!configBranch) {
					yield* setGitConfigEffect("agency.mainBranch", mainBranch, gitRoot)
				}

				// Current branch is not a feature branch if it's the main branch
				return currentBranch !== mainBranch
			}).pipe(
				Effect.mapError(
					() => new GitError({ message: "Failed to check if feature branch" }),
				),
			),

		getMainBranchConfig: (gitRoot: string) =>
			pipe(
				getGitConfigEffect("agency.mainBranch", gitRoot),
				Effect.mapError(
					() => new GitError({ message: "Failed to get main branch config" }),
				),
			),

		setMainBranchConfig: (mainBranch: string, gitRoot: string) =>
			setGitConfigEffect("agency.mainBranch", mainBranch, gitRoot),

		getDefaultBaseBranchConfig: (gitRoot: string) =>
			pipe(
				getGitConfigEffect("agency.baseBranch", gitRoot),
				Effect.mapError(
					() => new GitError({ message: "Failed to get base branch config" }),
				),
			),

		setDefaultBaseBranchConfig: (baseBranch: string, gitRoot: string) =>
			setGitConfigEffect("agency.baseBranch", baseBranch, gitRoot),

		findDefaultRemote: (gitRoot: string) =>
			pipe(
				findDefaultRemoteEffect(gitRoot),
				Effect.mapError(
					() => new GitError({ message: "Failed to find default remote" }),
				),
			),

		getRemoteConfig: (gitRoot: string) =>
			pipe(
				getGitConfigEffect("agency.remote", gitRoot),
				Effect.mapError(
					() => new GitError({ message: "Failed to get remote config" }),
				),
			),

		setRemoteConfig: (remote: string, gitRoot: string) =>
			setGitConfigEffect("agency.remote", remote, gitRoot),

		getAllRemotes: (gitRoot: string) =>
			pipe(
				runGitCommand(["git", "remote"], gitRoot),
				Effect.map((result) => {
					if (result.exitCode === 0 && result.stdout.trim()) {
						return result.stdout.trim().split("\n") as readonly string[]
					}
					return [] as readonly string[]
				}),
				Effect.mapError(
					() => new GitError({ message: "Failed to get list of remotes" }),
				),
			),

		remoteExists: (gitRoot: string, remoteName: string) =>
			Effect.gen(function* () {
				const remotes = yield* pipe(
					runGitCommand(["git", "remote"], gitRoot),
					Effect.map((result) => {
						if (result.exitCode === 0 && result.stdout.trim()) {
							return result.stdout.trim().split("\n")
						}
						return []
					}),
				)
				return remotes.includes(remoteName)
			}).pipe(
				Effect.mapError(
					() =>
						new GitError({
							message: `Failed to check if remote ${remoteName} exists`,
						}),
				),
			),

		getRemoteUrl: (gitRoot: string, remoteName: string) =>
			runGitCommandOrFail(
				["git", "remote", "get-url", remoteName],
				gitRoot,
			).pipe(
				Effect.mapError(
					() =>
						new GitError({
							message: `Failed to get URL for remote ${remoteName}`,
						}),
				),
			),

		resolveRemote: (gitRoot: string, providedRemote?: string) =>
			Effect.gen(function* () {
				// 1. If explicitly provided, validate and use it
				if (providedRemote) {
					const exists = yield* Effect.gen(function* () {
						const remotes = yield* pipe(
							runGitCommand(["git", "remote"], gitRoot),
							Effect.map((result) => {
								if (result.exitCode === 0 && result.stdout.trim()) {
									return result.stdout.trim().split("\n")
								}
								return []
							}),
						)
						return remotes.includes(providedRemote)
					})

					if (!exists) {
						return yield* Effect.fail(
							new GitError({
								message: `Remote '${providedRemote}' does not exist`,
							}),
						)
					}
					return providedRemote
				}

				// 2. Check for saved configuration
				const configRemote = yield* getGitConfigEffect(
					"agency.remote",
					gitRoot,
				).pipe(Effect.catchAll(() => Effect.succeed(null)))

				if (configRemote) {
					return configRemote
				}

				// 3. Auto-detect with smart precedence
				const remotes = yield* pipe(
					runGitCommand(["git", "remote"], gitRoot),
					Effect.map((result) => {
						if (result.exitCode === 0 && result.stdout.trim()) {
							return result.stdout.trim().split("\n")
						}
						return []
					}),
				)

				if (remotes.length === 0) {
					return yield* Effect.fail(
						new GitError({
							message:
								"No git remotes found. Add a remote with: git remote add <name> <url>",
						}),
					)
				}

				if (remotes.length === 1) {
					return remotes[0]!
				}

				// Multiple remotes: prefer origin > upstream > first alphabetically
				if (remotes.includes("origin")) {
					return "origin"
				}
				if (remotes.includes("upstream")) {
					return "upstream"
				}

				return remotes[0]!
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
				const remotes = yield* pipe(
					runGitCommand(["git", "remote"], gitRoot),
					Effect.map((result) => {
						if (result.exitCode === 0 && result.stdout.trim()) {
							return result.stdout.trim().split("\n")
						}
						return []
					}),
				)
				return remotes.some((remote) => branchName.startsWith(`${remote}/`))
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
				const remotes = yield* pipe(
					runGitCommand(["git", "remote"], gitRoot),
					Effect.map((result) => {
						if (result.exitCode === 0 && result.stdout.trim()) {
							return result.stdout.trim().split("\n")
						}
						return []
					}),
				)

				for (const remote of remotes) {
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
			pipe(
				runGitCommand(
					["git", "rev-parse", "--abbrev-ref", `${remoteName}/HEAD`],
					gitRoot,
				),
				Effect.map((result) => (result.exitCode === 0 ? result.stdout : null)),
				Effect.catchAll(() => Effect.succeed(null)),
			),

		getMergeBase: (gitRoot: string, branch1: string, branch2: string) =>
			runGitCommandOrFail(["git", "merge-base", branch1, branch2], gitRoot),

		getMergeBaseForkPoint: (
			gitRoot: string,
			baseBranch: string,
			featureBranch: string,
		) =>
			runGitCommandOrFail(
				["git", "merge-base", "--fork-point", baseBranch, featureBranch],
				gitRoot,
			),

		deleteBranch: (gitRoot: string, branchName: string, force = false) =>
			runGitCommandVoid(
				["git", "branch", force ? "-D" : "-d", branchName],
				gitRoot,
			),

		unsetGitConfig: (key: string, gitRoot: string) =>
			pipe(
				spawnProcess(["git", "config", "--unset", key], { cwd: gitRoot }),
				Effect.asVoid,
				// Ignore errors - the config might not exist, which is fine
				Effect.mapError(
					() => new GitError({ message: `Failed to unset config ${key}` }),
				),
			),

		checkCommandExists: (command: string) =>
			pipe(
				spawnProcess(["which", command]),
				Effect.map((result) => result.exitCode === 0),
				Effect.mapError(
					() =>
						new GitError({ message: `Failed to check if ${command} exists` }),
				),
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
			pipe(
				spawnProcess(args, {
					cwd: gitRoot,
					stdout: options?.captureOutput ? "pipe" : "inherit",
					stderr: "pipe",
					env: options?.env,
				}),
				Effect.mapError(
					(processError) =>
						new GitCommandError({
							command: processError.command,
							exitCode: processError.exitCode,
							stderr: processError.stderr,
						}),
				),
			),

		fetch: (gitRoot: string, remote?: string, branch?: string) => {
			const args = ["git", "fetch"]
			if (remote) {
				args.push(remote)
				if (branch) {
					args.push(branch)
				}
			}
			return runGitCommandVoid(args, gitRoot)
		},

		getCommitsBetween: (gitRoot: string, base: string, head: string) =>
			runGitCommandOrFail(
				["git", "rev-list", "--reverse", `${base}..${head}`],
				gitRoot,
			),

		cherryPick: (gitRoot: string, commit: string) =>
			runGitCommandVoid(["git", "cherry-pick", commit], gitRoot),

		getRemoteTrackingBranch: (gitRoot: string, branch: string) =>
			Effect.gen(function* () {
				const remote = yield* getGitConfigEffect(
					`branch.${branch}.remote`,
					gitRoot,
				).pipe(Effect.catchAll(() => Effect.succeed(null)))

				const merge = yield* getGitConfigEffect(
					`branch.${branch}.merge`,
					gitRoot,
				).pipe(Effect.catchAll(() => Effect.succeed(null)))

				if (!remote || !merge) {
					return null
				}

				// Convert refs/heads/branch to remote/branch
				const branchName = merge.replace(/^refs\/heads\//, "")
				return `${remote}/${branchName}`
			}),

		/**
		 * Read file contents from a specific git ref without checking out.
		 * Uses `git show <ref>:<path>` to read file contents directly.
		 * @param gitRoot - The git repository root
		 * @param ref - The git ref (branch name, commit, tag, etc.)
		 * @param filePath - Path to the file relative to git root
		 * @returns The file contents, or null if the file doesn't exist at that ref
		 */
		getFileAtRef: (gitRoot: string, ref: string, filePath: string) =>
			pipe(
				runGitCommand(["git", "show", `${ref}:${filePath}`], gitRoot),
				Effect.map((result) => (result.exitCode === 0 ? result.stdout : null)),
				Effect.catchAll(() => Effect.succeed(null)),
			),
	}),
}) {}
