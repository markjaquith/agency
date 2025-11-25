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
 */
export function ensureGitRepo() {
	return Effect.gen(function* () {
		const git = yield* GitService

		const isGitRepo = yield* git.isInsideGitRepo(process.cwd())
		if (!isGitRepo) {
			return yield* Effect.fail(
				new Error(
					"Not in a git repository. Please run this command inside a git repo.",
				),
			)
		}

		return yield* git.getGitRoot(process.cwd())
	})
}

/**
 * Get the configured template name for the current repository
 */
export function getTemplateName(gitRoot: string) {
	return Effect.gen(function* () {
		const git = yield* GitService
		return yield* git.getGitConfig("agency.template", gitRoot)
	})
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

		// Try common base branches in order
		const commonBases = ["origin/main", "origin/master", "main", "master"]
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
