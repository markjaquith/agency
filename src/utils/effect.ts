import { Effect } from "effect"
import { GitService } from "../services/GitService"
import { getBaseBranchFromMetadata } from "../types"
import highlight from "./colors"

/**
 * Ensure a branch exists, failing with an error if it doesn't
 */
export function ensureBranchExists(
	gitRoot: string,
	branch: string,
	errorMessage?: string,
) {
	return Effect.gen(function* () {
		const git = yield* GitService
		const exists = yield* git.branchExists(gitRoot, branch)
		if (!exists) {
			return yield* Effect.fail(
				new Error(
					errorMessage ?? `Branch ${highlight.branch(branch)} does not exist`,
				),
			)
		}
	})
}

/**
 * Create logging functions based on options
 */
export function createLoggers(options: {
	readonly silent?: boolean
	readonly verbose?: boolean
}) {
	const { silent = false, verbose = false } = options
	return {
		log: silent ? () => {} : console.log,
		verboseLog: verbose && !silent ? console.log : () => {},
	}
}

/**
 * Ensure we're in a git repository and return the git root
 * @param providedCwd - Optional working directory to use instead of process.cwd()
 */
export function ensureGitRepo(providedCwd?: string) {
	return Effect.gen(function* () {
		const git = yield* GitService
		const cwd = providedCwd ?? process.cwd()

		const isGitRepo = yield* git.isInsideGitRepo(cwd)
		if (!isGitRepo) {
			return yield* Effect.fail(
				new Error(
					"Not in a git repository. Please run this command inside a git repo.",
				),
			)
		}

		return yield* git.getGitRoot(cwd)
	})
}

/**
 * Get the configured template name for the current repository
 */
export function getTemplateName(gitRoot: string) {
	return Effect.flatMap(GitService, (git) =>
		git.getGitConfig("agency.template", gitRoot),
	)
}

/**
 * Resolve base branch with fallback chain:
 * 1. Explicitly provided base branch
 * 2. Branch-specific base branch from agency.json
 * 3. Repository-level default base branch from git config
 * 4. Auto-detected from origin/HEAD or common branches
 */
export function resolveBaseBranch(
	gitRoot: string,
	providedBaseBranch?: string,
) {
	return Effect.gen(function* () {
		const git = yield* GitService

		// If explicitly provided, use it
		if (providedBaseBranch) {
			yield* ensureBranchExists(gitRoot, providedBaseBranch)
			return providedBaseBranch
		}

		// Check if we have a branch-specific base branch in agency.json
		const savedBaseBranch = yield* Effect.tryPromise({
			try: () => getBaseBranchFromMetadata(gitRoot),
			catch: (error) =>
				new Error(`Failed to get base branch from metadata: ${error}`),
		})
		if (savedBaseBranch) {
			const exists = yield* git.branchExists(gitRoot, savedBaseBranch)
			if (exists) {
				return savedBaseBranch
			}
		}

		// Check for repository-level default base branch in git config
		const defaultBaseBranch = yield* git.getDefaultBaseBranchConfig(gitRoot)
		if (defaultBaseBranch) {
			const exists = yield* git.branchExists(gitRoot, defaultBaseBranch)
			if (exists) {
				return defaultBaseBranch
			}
		}

		// Try to auto-detect the default remote branch
		const defaultRemote = yield* git.getDefaultRemoteBranch(gitRoot)
		if (defaultRemote) {
			const exists = yield* git.branchExists(gitRoot, defaultRemote)
			if (exists) {
				return defaultRemote
			}
		}

		// Try common base branches in order, using resolved remote
		const remote = yield* git
			.resolveRemote(gitRoot)
			.pipe(Effect.catchAll(() => Effect.succeed(null)))

		const commonBases: string[] = []
		if (remote) {
			commonBases.push(`${remote}/main`, `${remote}/master`)
		}
		commonBases.push("main", "master")

		for (const base of commonBases) {
			const exists = yield* git.branchExists(gitRoot, base)
			if (exists) {
				return base
			}
		}

		// Could not auto-detect, require explicit specification
		return yield* Effect.fail(
			new Error(
				"Could not auto-detect base branch. Please specify one explicitly with the --base-branch option or configure one with: agency base set <branch>",
			),
		)
	})
}

/**
 * Get base branch from agency.json metadata as an Effect
 */
export function getBaseBranchFromMetadataEffect(gitRoot: string) {
	return Effect.tryPromise({
		try: () => getBaseBranchFromMetadata(gitRoot),
		catch: (error) =>
			new Error(`Failed to get base branch from metadata: ${error}`),
	})
}

/**
 * Get base branch from agency.json on a specific branch without checking it out.
 * Uses git show to read the file contents directly.
 */
export function getBaseBranchFromBranch(gitRoot: string, branch: string) {
	return Effect.gen(function* () {
		const git = yield* GitService

		// Use git show to read agency.json from the branch
		const content = yield* git.getFileAtRef(gitRoot, branch, "agency.json")

		if (!content) {
			return null
		}

		// Parse the content
		const data = yield* Effect.try({
			try: () => JSON.parse(content),
			catch: () => null,
		}).pipe(Effect.catchAll(() => Effect.succeed(null)))

		if (!data || typeof data !== "object") {
			return null
		}

		return (data as { baseBranch?: string }).baseBranch || null
	}).pipe(Effect.catchAll(() => Effect.succeed(null)))
}

/**
 * Get the configured remote name with fallback to auto-detection
 */
export function getRemoteName(gitRoot: string) {
	return Effect.gen(function* () {
		const git = yield* GitService

		// Use the new centralized resolveRemote method
		// This already handles config checking and auto-detection with smart precedence
		const remote = yield* git.resolveRemote(gitRoot)

		return remote
	})
}

/**
 * Execute an operation that may change branches, with automatic cleanup on interrupt.
 * This ensures that if Ctrl-C is pressed during an operation that changes branches,
 * the user is returned to their original branch.
 *
 * @param gitRoot - The git repository root
 * @param operation - The Effect operation to run
 * @returns The result of the operation
 */
export function withBranchProtection<A, E, R>(
	gitRoot: string,
	operation: Effect.Effect<A, E, R>,
) {
	return Effect.gen(function* () {
		const git = yield* GitService

		// Store the original branch before any operations
		const originalBranch = yield* git.getCurrentBranch(gitRoot)

		// Set up SIGINT handler to restore branch on interrupt
		let interrupted = false
		const originalSigintHandler = process.listeners("SIGINT")

		const cleanup = async () => {
			if (interrupted) return
			interrupted = true

			// Restore original SIGINT handlers
			process.removeAllListeners("SIGINT")
			for (const handler of originalSigintHandler) {
				process.on("SIGINT", handler as NodeJS.SignalsListener)
			}

			// Try to restore the original branch
			try {
				const currentBranch = await Effect.runPromise(
					git
						.getCurrentBranch(gitRoot)
						.pipe(Effect.provide(GitService.Default)),
				)

				if (currentBranch !== originalBranch) {
					await Effect.runPromise(
						git
							.checkoutBranch(gitRoot, originalBranch)
							.pipe(Effect.provide(GitService.Default)),
					)
					console.error(`\nInterrupted. Restored to branch: ${originalBranch}`)
				}
			} catch {
				console.error(
					`\nInterrupted. Could not restore branch. You may need to run: git checkout ${originalBranch}`,
				)
			}

			// Exit the process
			process.exit(130) // Standard exit code for SIGINT
		}

		// Install our SIGINT handler
		process.removeAllListeners("SIGINT")
		process.on("SIGINT", cleanup)

		// Run the operation
		const result = yield* Effect.onExit(operation, () =>
			Effect.sync(() => {
				// Restore original SIGINT handlers when operation completes
				process.removeAllListeners("SIGINT")
				for (const handler of originalSigintHandler) {
					process.on("SIGINT", handler as NodeJS.SignalsListener)
				}
			}),
		)

		return result
	})
}
