import { Effect, Layer, pipe } from "effect"
import { resolve } from "path"
import { realpath } from "fs/promises"
import {
	GitService,
	GitError,
	NotInGitRepoError,
	GitCommandError,
} from "./GitService"

// Helper to run git commands with proper error handling
const runGitCommand = (args: readonly string[], cwd: string) =>
	Effect.tryPromise({
		try: async () => {
			const proc = Bun.spawn([...args], {
				cwd,
				stdout: "pipe",
				stderr: "pipe",
			})

			await proc.exited

			const stdout = await new Response(proc.stdout).text()
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
	})

// Helper to run git commands and check exit code (DRY pattern)
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

// Helper to run git commands that don't return output (void)
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

// Create the live implementation
export const GitServiceLive = Layer.succeed(
	GitService,
	GitService.of({
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
			Effect.tryPromise({
				try: async () => {
					const proc = Bun.spawn(["git", "config", "--local", "--get", key], {
						cwd: gitRoot,
						stdout: "pipe",
						stderr: "pipe",
					})

					await proc.exited

					if (proc.exitCode !== 0) {
						return null
					}

					const output = await new Response(proc.stdout).text()
					return output.trim()
				},
				catch: () =>
					new GitError({ message: `Failed to get git config ${key}` }),
			}),

		setGitConfig: (key: string, value: string, gitRoot: string) =>
			Effect.tryPromise({
				try: async () => {
					const proc = Bun.spawn(["git", "config", "--local", key, value], {
						cwd: gitRoot,
						stdout: "pipe",
						stderr: "pipe",
					})

					await proc.exited

					if (proc.exitCode !== 0) {
						const stderr = await new Response(proc.stderr).text()
						throw new Error(`Failed to set git config ${key}: ${stderr}`)
					}
				},
				catch: (error) =>
					new GitError({
						message:
							error instanceof Error
								? error.message
								: "Failed to set git config",
					}),
			}),

		getCurrentBranch: (gitRoot: string) =>
			runGitCommandOrFail(["git", "branch", "--show-current"], gitRoot),

		branchExists: (gitRoot: string, branch: string) =>
			Effect.tryPromise({
				try: async () => {
					// Check if it's a remote branch
					const remotePattern = /^(origin|upstream|fork)\//
					if (remotePattern.test(branch)) {
						const proc = Bun.spawn(
							[
								"git",
								"show-ref",
								"--verify",
								"--quiet",
								`refs/remotes/${branch}`,
							],
							{
								cwd: gitRoot,
								stdout: "pipe",
								stderr: "pipe",
							},
						)
						await proc.exited
						return proc.exitCode === 0
					}

					// Check for local branch
					const proc = Bun.spawn(
						["git", "show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
						{
							cwd: gitRoot,
							stdout: "pipe",
							stderr: "pipe",
						},
					)

					await proc.exited
					return proc.exitCode === 0
				},
				catch: () =>
					new GitError({
						message: `Failed to check if branch exists: ${branch}`,
					}),
			}),

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
			Effect.tryPromise({
				try: async () => {
					const proc = Bun.spawn(
						["git", "rev-parse", "--abbrev-ref", "origin/HEAD"],
						{
							cwd: gitRoot,
							stdout: "pipe",
							stderr: "pipe",
						},
					)

					await proc.exited

					if (proc.exitCode === 0) {
						const output = await new Response(proc.stdout).text()
						return output.trim()
					}

					return null
				},
				catch: () =>
					new GitError({ message: "Failed to get default remote branch" }),
			}),

		// These methods need to access the service context, so we'll implement them differently
		findMainBranch: (gitRoot: string) =>
			Effect.tryPromise({
				try: async () => {
					// First check for origin/HEAD
					const proc1 = Bun.spawn(
						["git", "rev-parse", "--abbrev-ref", "origin/HEAD"],
						{
							cwd: gitRoot,
							stdout: "pipe",
							stderr: "pipe",
						},
					)
					await proc1.exited

					if (proc1.exitCode === 0) {
						const output = await new Response(proc1.stdout).text()
						const defaultRemote = output.trim()

						// Check if it exists
						const proc2 = Bun.spawn(
							[
								"git",
								"show-ref",
								"--verify",
								"--quiet",
								`refs/remotes/${defaultRemote}`,
							],
							{
								cwd: gitRoot,
								stdout: "pipe",
								stderr: "pipe",
							},
						)
						await proc2.exited

						if (proc2.exitCode === 0) {
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
						const proc = Bun.spawn(
							["git", "show-ref", "--verify", "--quiet", `refs/heads/${base}`],
							{
								cwd: gitRoot,
								stdout: "pipe",
								stderr: "pipe",
							},
						)
						await proc.exited

						if (proc.exitCode === 0) {
							return base
						}
					}

					return null
				},
				catch: () => new GitError({ message: "Failed to find main branch" }),
			}),

		getSuggestedBaseBranches: (gitRoot: string) =>
			Effect.tryPromise({
				try: async () => {
					const suggestions: string[] = []

					// Get the main branch from config or find it
					let mainBranch: string | null = null

					// Try to get from config first
					const configProc = Bun.spawn(
						["git", "config", "--local", "--get", "agency.mainBranch"],
						{
							cwd: gitRoot,
							stdout: "pipe",
							stderr: "pipe",
						},
					)
					await configProc.exited

					if (configProc.exitCode === 0) {
						const output = await new Response(configProc.stdout).text()
						mainBranch = output.trim()
					}

					// If not in config, try to find it
					if (!mainBranch) {
						// Implementation from findMainBranch inlined
						const proc1 = Bun.spawn(
							["git", "rev-parse", "--abbrev-ref", "origin/HEAD"],
							{
								cwd: gitRoot,
								stdout: "pipe",
								stderr: "pipe",
							},
						)
						await proc1.exited

						if (proc1.exitCode === 0) {
							const output = await new Response(proc1.stdout).text()
							const defaultRemote = output.trim()
							const match = defaultRemote.match(/^origin\/(.+)$/)
							if (match?.[1]) {
								mainBranch = match[1]
							}
						}

						if (!mainBranch) {
							const commonBases = ["main", "master"]
							for (const base of commonBases) {
								const proc = Bun.spawn(
									[
										"git",
										"show-ref",
										"--verify",
										"--quiet",
										`refs/heads/${base}`,
									],
									{
										cwd: gitRoot,
										stdout: "pipe",
										stderr: "pipe",
									},
								)
								await proc.exited

								if (proc.exitCode === 0) {
									mainBranch = base
									break
								}
							}
						}
					}

					if (mainBranch) {
						suggestions.push(mainBranch)
					}

					// Check for other common base branches
					const commonBases = ["develop", "development", "staging"]
					for (const base of commonBases) {
						const proc = Bun.spawn(
							["git", "show-ref", "--verify", "--quiet", `refs/heads/${base}`],
							{
								cwd: gitRoot,
								stdout: "pipe",
								stderr: "pipe",
							},
						)
						await proc.exited

						if (proc.exitCode === 0 && !suggestions.includes(base)) {
							suggestions.push(base)
						}
					}

					// Get current branch as a suggestion too
					const currentProc = Bun.spawn(["git", "branch", "--show-current"], {
						cwd: gitRoot,
						stdout: "pipe",
						stderr: "pipe",
					})
					await currentProc.exited

					if (currentProc.exitCode === 0) {
						const output = await new Response(currentProc.stdout).text()
						const currentBranch = output.trim()
						if (currentBranch && !suggestions.includes(currentBranch)) {
							suggestions.push(currentBranch)
						}
					}

					return suggestions as readonly string[]
				},
				catch: () =>
					new GitError({ message: "Failed to get suggested base branches" }),
			}),

		isFeatureBranch: (currentBranch: string, gitRoot: string) =>
			Effect.tryPromise({
				try: async () => {
					// Get the main branch from config
					let mainBranch: string | null = null

					const configProc = Bun.spawn(
						["git", "config", "--local", "--get", "agency.mainBranch"],
						{
							cwd: gitRoot,
							stdout: "pipe",
							stderr: "pipe",
						},
					)
					await configProc.exited

					if (configProc.exitCode === 0) {
						const output = await new Response(configProc.stdout).text()
						mainBranch = output.trim()
					}

					// If not in config, try to find it
					if (!mainBranch) {
						// Check origin/HEAD first
						const proc1 = Bun.spawn(
							["git", "rev-parse", "--abbrev-ref", "origin/HEAD"],
							{
								cwd: gitRoot,
								stdout: "pipe",
								stderr: "pipe",
							},
						)
						await proc1.exited

						if (proc1.exitCode === 0) {
							const output = await new Response(proc1.stdout).text()
							const defaultRemote = output.trim()
							const match = defaultRemote.match(/^origin\/(.+)$/)
							if (match?.[1]) {
								mainBranch = match[1]
							}
						}

						// Try common branches
						if (!mainBranch) {
							const commonBases = ["main", "master"]
							for (const base of commonBases) {
								const proc = Bun.spawn(
									[
										"git",
										"show-ref",
										"--verify",
										"--quiet",
										`refs/heads/${base}`,
									],
									{
										cwd: gitRoot,
										stdout: "pipe",
										stderr: "pipe",
									},
								)
								await proc.exited

								if (proc.exitCode === 0) {
									mainBranch = base

									// Save it for future use
									Bun.spawn(
										["git", "config", "--local", "agency.mainBranch", base],
										{ cwd: gitRoot },
									)

									break
								}
							}
						}
					}

					// If we couldn't determine a main branch, assume current is a feature branch
					if (!mainBranch) {
						return true
					}

					// Current branch is not a feature branch if it's the main branch
					return currentBranch !== mainBranch
				},
				catch: () =>
					new GitError({ message: "Failed to check if feature branch" }),
			}),

		getMainBranchConfig: (gitRoot: string) =>
			Effect.tryPromise({
				try: async () => {
					const proc = Bun.spawn(
						["git", "config", "--local", "--get", "agency.mainBranch"],
						{
							cwd: gitRoot,
							stdout: "pipe",
							stderr: "pipe",
						},
					)
					await proc.exited

					if (proc.exitCode === 0) {
						const output = await new Response(proc.stdout).text()
						return output.trim()
					}

					return null
				},
				catch: () =>
					new GitError({ message: "Failed to get main branch config" }),
			}),

		setMainBranchConfig: (mainBranch: string, gitRoot: string) =>
			Effect.tryPromise({
				try: async () => {
					const proc = Bun.spawn(
						["git", "config", "--local", "agency.mainBranch", mainBranch],
						{
							cwd: gitRoot,
							stdout: "pipe",
							stderr: "pipe",
						},
					)
					await proc.exited

					if (proc.exitCode !== 0) {
						const stderr = await new Response(proc.stderr).text()
						throw new Error(`Failed to set main branch config: ${stderr}`)
					}
				},
				catch: (error) =>
					new GitError({
						message:
							error instanceof Error
								? error.message
								: "Failed to set main branch config",
					}),
			}),

		getDefaultBaseBranchConfig: (gitRoot: string) =>
			Effect.tryPromise({
				try: async () => {
					const proc = Bun.spawn(
						["git", "config", "--local", "--get", "agency.baseBranch"],
						{
							cwd: gitRoot,
							stdout: "pipe",
							stderr: "pipe",
						},
					)
					await proc.exited

					if (proc.exitCode === 0) {
						const output = await new Response(proc.stdout).text()
						return output.trim()
					}

					return null
				},
				catch: () =>
					new GitError({ message: "Failed to get base branch config" }),
			}),

		setDefaultBaseBranchConfig: (baseBranch: string, gitRoot: string) =>
			Effect.tryPromise({
				try: async () => {
					const proc = Bun.spawn(
						["git", "config", "--local", "agency.baseBranch", baseBranch],
						{
							cwd: gitRoot,
							stdout: "pipe",
							stderr: "pipe",
						},
					)
					await proc.exited

					if (proc.exitCode !== 0) {
						const stderr = await new Response(proc.stderr).text()
						throw new Error(`Failed to set base branch config: ${stderr}`)
					}
				},
				catch: (error) =>
					new GitError({
						message:
							error instanceof Error
								? error.message
								: "Failed to set base branch config",
					}),
			}),

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
)
