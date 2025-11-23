import { Effect, Data, pipe } from "effect"
import { resolve } from "path"
import { realpath } from "fs/promises"

// Error types for Git operations
export class GitError extends Data.TaggedError("GitError")<{
	message: string
	cause?: unknown
}> {}

export class NotInGitRepoError extends Data.TaggedError("NotInGitRepoError")<{
	path: string
}> {}

export class GitCommandError extends Data.TaggedError("GitCommandError")<{
	command: string
	exitCode: number
	stderr: string
}> {}

// Generic helper to spawn a process with proper error handling
const spawnProcess = (
	args: readonly string[],
	cwd: string,
	options?: {
		readonly stdout?: "pipe" | "inherit"
		readonly stderr?: "pipe" | "inherit"
	},
) =>
	Effect.tryPromise({
		try: async () => {
			const proc = Bun.spawn([...args], {
				cwd,
				stdout: options?.stdout ?? "pipe",
				stderr: options?.stderr ?? "pipe",
			})

			await proc.exited

			const stdout =
				options?.stdout === "inherit"
					? ""
					: await new Response(proc.stdout).text()
			const stderr =
				options?.stderr === "inherit"
					? ""
					: await new Response(proc.stderr).text()

			return {
				stdout: stdout.trim(),
				stderr: stderr.trim(),
				exitCode: proc.exitCode ?? 0,
			}
		},
		catch: (error) =>
			new GitCommandError({
				command: args.join(" "),
				exitCode: -1,
				stderr: error instanceof Error ? error.message : String(error),
			}),
	})

// Helper to run git commands with proper error handling
const runGitCommand = (args: readonly string[], cwd: string) =>
	spawnProcess(args, cwd)

// Helper to run git commands and check exit code
const runGitCommandOrFail = (args: readonly string[], cwd: string) =>
	pipe(
		runGitCommand(args, cwd),
		Effect.flatMap((result) =>
			result.exitCode === 0
				? Effect.succeed(result.stdout)
				: Effect.fail(
						new GitCommandError({
							command: args.join(" "),
							exitCode: result.exitCode,
							stderr: result.stderr,
						}),
					),
		),
	)

// Helper to run git commands that return void
const runGitCommandVoid = (args: readonly string[], cwd: string) =>
	pipe(
		runGitCommand(args, cwd),
		Effect.flatMap((result) =>
			result.exitCode === 0
				? Effect.void
				: Effect.fail(
						new GitCommandError({
							command: args.join(" "),
							exitCode: result.exitCode,
							stderr: result.stderr,
						}),
					),
		),
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
			Effect.tryPromise({
				try: async () => {
					const proc = Bun.spawn(
						["git", "rev-parse", "--is-inside-work-tree"],
						{
							cwd: path,
							stdout: "pipe",
							stderr: "pipe",
						},
					)
					await proc.exited
					return proc.exitCode === 0
				},
				catch: () =>
					new GitError({ message: "Failed to check git repo status" }),
			}),

		getGitRoot: (path: string) =>
			Effect.tryPromise({
				try: async () => {
					const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
						cwd: path,
						stdout: "pipe",
						stderr: "pipe",
					})

					await proc.exited

					if (proc.exitCode !== 0) {
						throw new Error("Not in git repo")
					}

					const output = await new Response(proc.stdout).text()
					return output.trim()
				},
				catch: () => new NotInGitRepoError({ path }),
			}),

		isGitRoot: (path: string) =>
			Effect.tryPromise({
				try: async () => {
					const absolutePath = await realpath(resolve(path))

					const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
						cwd: absolutePath,
						stdout: "pipe",
						stderr: "pipe",
					})

					await proc.exited

					if (proc.exitCode !== 0) {
						return false
					}

					const output = await new Response(proc.stdout).text()
					const gitRoot = output.trim()

					const gitRootReal = await realpath(gitRoot)
					return gitRootReal === absolutePath
				},
				catch: () => new GitError({ message: "Failed to check if git root" }),
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

		getMergeBase: (gitRoot: string, branch1: string, branch2: string) =>
			runGitCommandOrFail(["git", "merge-base", branch1, branch2], gitRoot),

		deleteBranch: (gitRoot: string, branchName: string, force = false) =>
			runGitCommandVoid(
				["git", "branch", force ? "-D" : "-d", branchName],
				gitRoot,
			),

		unsetGitConfig: (key: string, gitRoot: string) =>
			Effect.tryPromise({
				try: async () => {
					const proc = Bun.spawn(["git", "config", "--unset", key], {
						cwd: gitRoot,
						stdout: "pipe",
						stderr: "pipe",
					})
					await proc.exited
					// Ignore errors - the config might not exist, which is fine
				},
				catch: () => new GitError({ message: `Failed to unset config ${key}` }),
			}),

		checkCommandExists: (command: string) =>
			Effect.tryPromise({
				try: async () => {
					const proc = Bun.spawn(["which", command], {
						stdout: "pipe",
						stderr: "pipe",
					})
					await proc.exited
					return proc.exitCode === 0
				},
				catch: () =>
					new GitError({ message: `Failed to check if ${command} exists` }),
			}),

		runGitCommand: (
			args: readonly string[],
			gitRoot: string,
			options?: {
				readonly env?: Record<string, string>
				readonly stdin?: string
				readonly captureOutput?: boolean
			},
		) =>
			Effect.tryPromise({
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

					return {
						stdout: stdout.trim(),
						stderr: stderr.trim(),
						exitCode: proc.exitCode ?? 0,
					}
				},
				catch: (error) =>
					new GitCommandError({
						command: args.join(" "),
						exitCode: -1,
						stderr: error instanceof Error ? error.message : String(error),
					}),
			}),
	}),
}) {}
