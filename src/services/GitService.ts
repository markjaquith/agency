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
		// Check if it's a remote branch
		const remotePattern = /^(origin|upstream|fork)\//
		const ref = remotePattern.test(branch)
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
		// First check for origin/HEAD
		const originHeadResult = yield* runGitCommand(
			["git", "rev-parse", "--abbrev-ref", "origin/HEAD"],
			gitRoot,
		)

		if (originHeadResult.exitCode === 0) {
			const defaultRemote = originHeadResult.stdout

			// Check if it exists
			const exists = yield* branchExistsEffect(gitRoot, defaultRemote)
			if (exists) {
				// Strip the remote prefix if present
				const match = defaultRemote.match(/^origin\/(.+)$/)
				if (match?.[1]) {
					return match[1]
				}
				return defaultRemote
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
			pipe(
				runGitCommand(
					["git", "rev-parse", "--abbrev-ref", "origin/HEAD"],
					gitRoot,
				),
				Effect.map((result) => (result.exitCode === 0 ? result.stdout : null)),
				Effect.catchAll(() => Effect.succeed(null)),
			),

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
	}),
}) {}
