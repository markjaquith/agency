import { Effect, pipe } from "effect"
import { GitService } from "../services/GitService"
import { GitServiceLive } from "../services/GitServiceLive"

/**
 * Helper function to run an Effect with the GitService
 * This provides backward compatibility with the existing async functions
 */
const runWithGitService = <A, E>(effect: Effect.Effect<A, E, GitService>) =>
	Effect.runPromise(pipe(effect, Effect.provide(GitServiceLive)))

/**
 * Check if a directory is inside a git repository
 */
export async function isInsideGitRepo(path: string): Promise<boolean> {
	try {
		return await runWithGitService(
			Effect.gen(function* () {
				const git = yield* GitService
				return yield* git.isInsideGitRepo(path)
			}),
		)
	} catch {
		return false
	}
}

/**
 * Get the git repository root directory
 */
export async function getGitRoot(path: string): Promise<string | null> {
	try {
		return await runWithGitService(
			Effect.gen(function* () {
				const git = yield* GitService
				return yield* git.getGitRoot(path)
			}),
		)
	} catch {
		return null
	}
}

/**
 * Check if a path is the root of a git repository
 */
export async function isGitRoot(path: string): Promise<boolean> {
	try {
		return await runWithGitService(
			Effect.gen(function* () {
				const git = yield* GitService
				return yield* git.isGitRoot(path)
			}),
		)
	} catch {
		return false
	}
}

/**
 * Get a git config value from the repository
 */
export async function getGitConfig(
	key: string,
	gitRoot: string,
): Promise<string | null> {
	try {
		return await runWithGitService(
			Effect.gen(function* () {
				const git = yield* GitService
				return yield* git.getGitConfig(key, gitRoot)
			}),
		)
	} catch {
		return null
	}
}

/**
 * Set a git config value in the repository
 */
export async function setGitConfig(
	key: string,
	value: string,
	gitRoot: string,
): Promise<void> {
	await runWithGitService(
		Effect.gen(function* () {
			const git = yield* GitService
			yield* git.setGitConfig(key, value, gitRoot)
		}),
	)
}

/**
 * Get the repository-level default base branch from git config
 */
export async function getDefaultBaseBranchConfig(
	gitRoot: string,
): Promise<string | null> {
	try {
		return await runWithGitService(
			Effect.gen(function* () {
				const git = yield* GitService
				return yield* git.getDefaultBaseBranchConfig(gitRoot)
			}),
		)
	} catch {
		return null
	}
}

/**
 * Set the repository-level default base branch in git config
 */
export async function setDefaultBaseBranchConfig(
	baseBranch: string,
	gitRoot: string,
): Promise<void> {
	await runWithGitService(
		Effect.gen(function* () {
			const git = yield* GitService
			yield* git.setDefaultBaseBranchConfig(baseBranch, gitRoot)
		}),
	)
}

/**
 * Get the current branch name
 */
export async function getCurrentBranch(gitRoot: string): Promise<string> {
	return await runWithGitService(
		Effect.gen(function* () {
			const git = yield* GitService
			return yield* git.getCurrentBranch(gitRoot)
		}),
	).catch((error: any) => {
		throw new Error(
			error.stderr || error.message || "Failed to get current branch",
		)
	})
}

/**
 * Check if a branch exists (local or remote)
 */
export async function branchExists(
	gitRoot: string,
	branch: string,
): Promise<boolean> {
	try {
		return await runWithGitService(
			Effect.gen(function* () {
				const git = yield* GitService
				return yield* git.branchExists(gitRoot, branch)
			}),
		)
	} catch {
		return false
	}
}

/**
 * Get the default remote branch (usually origin/main or origin/master)
 */
export async function getDefaultRemoteBranch(
	gitRoot: string,
): Promise<string | null> {
	try {
		return await runWithGitService(
			Effect.gen(function* () {
				const git = yield* GitService
				return yield* git.getDefaultRemoteBranch(gitRoot)
			}),
		)
	} catch {
		return null
	}
}

/**
 * Find the main/base branch for this repository
 * Returns the branch name without the remote prefix (e.g., "main" instead of "origin/main")
 */
export async function findMainBranch(gitRoot: string): Promise<string | null> {
	try {
		return await runWithGitService(
			Effect.gen(function* () {
				const git = yield* GitService
				return yield* git.findMainBranch(gitRoot)
			}),
		)
	} catch {
		return null
	}
}

/**
 * Get the configured main branch for this repository
 */
export async function getMainBranchConfig(
	gitRoot: string,
): Promise<string | null> {
	try {
		return await runWithGitService(
			Effect.gen(function* () {
				const git = yield* GitService
				return yield* git.getMainBranchConfig(gitRoot)
			}),
		)
	} catch {
		return null
	}
}

/**
 * Set the main branch configuration for this repository
 */
export async function setMainBranchConfig(
	mainBranch: string,
	gitRoot: string,
): Promise<void> {
	await runWithGitService(
		Effect.gen(function* () {
			const git = yield* GitService
			yield* git.setMainBranchConfig(mainBranch, gitRoot)
		}),
	)
}

/**
 * Check if the current branch is a feature branch
 * A branch is considered a feature branch if it's not the main branch
 */
export async function isFeatureBranch(
	currentBranch: string,
	gitRoot: string,
): Promise<boolean> {
	try {
		return await runWithGitService(
			Effect.gen(function* () {
				const git = yield* GitService
				return yield* git.isFeatureBranch(currentBranch, gitRoot)
			}),
		)
	} catch {
		// If there's an error, assume it's a feature branch
		return true
	}
}

/**
 * Get suggested base branches for creating a new branch
 * Returns common base branches like main, master, develop that exist in the repo
 */
export async function getSuggestedBaseBranches(
	gitRoot: string,
): Promise<string[]> {
	try {
		const result = await runWithGitService(
			Effect.gen(function* () {
				const git = yield* GitService
				return yield* git.getSuggestedBaseBranches(gitRoot)
			}),
		)
		// Convert readonly array to regular array
		return [...result]
	} catch {
		return []
	}
}

/**
 * Create a new branch from a base branch
 */
export async function createBranch(
	branchName: string,
	gitRoot: string,
	baseBranch?: string,
): Promise<void> {
	await runWithGitService(
		Effect.gen(function* () {
			const git = yield* GitService
			yield* git.createBranch(branchName, gitRoot, baseBranch)
		}),
	).catch((error: any) => {
		throw new Error(
			error.stderr || error.message || `Failed to create branch: ${error}`,
		)
	})
}

/**
 * Stage files for commit
 */
export async function gitAdd(files: string[], gitRoot: string): Promise<void> {
	await runWithGitService(
		Effect.gen(function* () {
			const git = yield* GitService
			yield* git.gitAdd(files, gitRoot)
		}),
	).catch((error: any) => {
		throw new Error(
			error.stderr || error.message || `Failed to stage files: ${error}`,
		)
	})
}

/**
 * Create a git commit
 */
export async function gitCommit(
	message: string,
	gitRoot: string,
	options?: { noVerify?: boolean },
): Promise<void> {
	await runWithGitService(
		Effect.gen(function* () {
			const git = yield* GitService
			yield* git.gitCommit(message, gitRoot, options)
		}),
	).catch((error: any) => {
		throw new Error(
			error.stderr || error.message || `Failed to commit: ${error}`,
		)
	})
}

/**
 * Checkout a branch
 */
export async function checkoutBranch(
	gitRoot: string,
	branch: string,
): Promise<void> {
	await runWithGitService(
		Effect.gen(function* () {
			const git = yield* GitService
			yield* git.checkoutBranch(gitRoot, branch)
		}),
	).catch((error: any) => {
		throw new Error(
			error.stderr || error.message || `Failed to checkout branch: ${error}`,
		)
	})
}
