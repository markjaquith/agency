/**
 * Utilities for working with PR branch names and patterns
 */

import { Effect, pipe } from "effect"
import { join } from "path"
import { FileSystemService } from "../services/FileSystemService"
import { GitService } from "../services/GitService"
import { AgencyMetadata } from "../schemas"
import { Schema } from "@effect/schema"

/**
 * Generate a PR branch name from a pattern and source branch name.
 * If pattern contains %branch%, it replaces it with the branch name.
 * Otherwise, treats the pattern as a suffix.
 *
 * @example
 * makePrBranchName("feature-foo", "%branch%--PR") // "feature-foo--PR"
 * makePrBranchName("feature-foo", "PR/%branch%") // "PR/feature-foo"
 * makePrBranchName("feature-foo", "--PR") // "feature-foo--PR"
 */
export function makePrBranchName(branchName: string, pattern: string): string {
	if (pattern.includes("%branch%")) {
		return pattern.replace("%branch%", branchName)
	}

	// If no %branch% placeholder, treat pattern as suffix
	return branchName + pattern
}

/**
 * Extract the source branch name from a PR branch name using a pattern.
 * Returns null if the PR branch name doesn't match the pattern.
 *
 * @example
 * extractSourceBranch("feature-foo--PR", "%branch%--PR") // "feature-foo"
 * extractSourceBranch("PR/feature-foo", "PR/%branch%") // "feature-foo"
 * extractSourceBranch("feature-foo--PR", "--PR") // "feature-foo"
 * extractSourceBranch("main", "%branch%--PR") // null
 */
export function extractSourceBranch(
	prBranchName: string,
	pattern: string,
): string | null {
	if (pattern.includes("%branch%")) {
		// Split pattern into prefix and suffix around %branch%
		const parts = pattern.split("%branch%")
		if (parts.length !== 2) return null

		const prefix = parts[0]!
		const suffix = parts[1]!

		// Check if PR branch name matches the pattern
		if (!prBranchName.startsWith(prefix) || !prBranchName.endsWith(suffix)) {
			return null
		}

		// Extract the branch name by removing prefix and suffix
		const sourceBranch = prBranchName.slice(
			prefix.length,
			prBranchName.length - suffix.length,
		)

		// Ensure we extracted something (not empty string)
		return sourceBranch.length > 0 ? sourceBranch : null
	} else {
		// Pattern is a suffix - check if branch ends with it
		if (!prBranchName.endsWith(pattern)) {
			return null
		}

		const sourceBranch = prBranchName.slice(0, -pattern.length)
		return sourceBranch.length > 0 ? sourceBranch : null
	}
}

/**
 * Result of resolving a branch pair (source and PR branches).
 */
export interface BranchPair {
	/** The source branch name (without PR suffix) */
	sourceBranch: string
	/** The PR branch name (with PR suffix) */
	prBranch: string
	/** Whether the current branch is the PR branch */
	isOnPrBranch: boolean
}

/**
 * Resolve the source and PR branch names from a current branch and pattern.
 * This determines whether we're on a PR branch or source branch and provides
 * both branch names.
 *
 * @example
 * resolveBranchPair("feature-foo", "%branch%--PR")
 * // { sourceBranch: "feature-foo", prBranch: "feature-foo--PR", isOnPrBranch: false }
 *
 * resolveBranchPair("feature-foo--PR", "%branch%--PR")
 * // { sourceBranch: "feature-foo", prBranch: "feature-foo--PR", isOnPrBranch: true }
 */
export function resolveBranchPair(
	currentBranch: string,
	pattern: string,
): BranchPair {
	const sourceBranch = extractSourceBranch(currentBranch, pattern)

	if (sourceBranch) {
		// Current branch is a PR branch
		return {
			sourceBranch,
			prBranch: currentBranch,
			isOnPrBranch: true,
		}
	} else {
		// Current branch is a source branch
		return {
			sourceBranch: currentBranch,
			prBranch: makePrBranchName(currentBranch, pattern),
			isOnPrBranch: false,
		}
	}
}

/**
 * Effect-based utilities for resolving branch pairs using agency.json
 */

/**
 * Try to read agency.json from the git root on a specific branch.
 * Returns the metadata if found, null otherwise.
 */
const readAgencyJsonFromBranch = (
	gitRoot: string,
	branch: string,
): Effect.Effect<
	AgencyMetadata | null,
	never,
	GitService | FileSystemService
> =>
	Effect.gen(function* () {
		const git = yield* GitService
		const fs = yield* FileSystemService

		// Try to read agency.json from the branch using git show
		const result = yield* pipe(
			git.runGitCommand(["git", "show", `${branch}:agency.json`], gitRoot, {
				captureOutput: true,
			}),
			Effect.map((r) => (r.exitCode === 0 ? r.stdout : null)),
			Effect.catchAll(() => Effect.succeed(null)),
		)

		if (!result) {
			return null
		}

		// Parse and validate the JSON
		const parsed = yield* pipe(
			Effect.try({
				try: () => JSON.parse(result),
				catch: () => null,
			}),
			Effect.catchAll(() => Effect.succeed(null)),
		)

		if (!parsed) {
			return null
		}

		// Validate against schema
		const validated = yield* pipe(
			Schema.decodeUnknown(AgencyMetadata)(parsed),
			Effect.catchAll(() => Effect.succeed(null)),
		)

		return validated
	})

/**
 * Get the agency.json metadata from the current branch (if it exists).
 */
const getCurrentBranchAgencyJson = (
	gitRoot: string,
): Effect.Effect<
	AgencyMetadata | null,
	never,
	FileSystemService | GitService
> =>
	Effect.gen(function* () {
		const fs = yield* FileSystemService
		const agencyJsonPath = join(gitRoot, "agency.json")

		// Check if agency.json exists
		const exists = yield* pipe(
			fs.exists(agencyJsonPath),
			Effect.catchAll(() => Effect.succeed(false)),
		)

		if (!exists) {
			return null
		}

		// Read and parse the file
		const content = yield* pipe(
			fs.readFile(agencyJsonPath),
			Effect.catchAll(() => Effect.succeed(null)),
		)

		if (!content) {
			return null
		}

		const parsed = yield* pipe(
			Effect.try({
				try: () => JSON.parse(content),
				catch: () => null,
			}),
			Effect.catchAll(() => Effect.succeed(null)),
		)

		if (!parsed) {
			return null
		}

		// Validate against schema
		const validated = yield* pipe(
			Schema.decodeUnknown(AgencyMetadata)(parsed),
			Effect.catchAll(() => Effect.succeed(null)),
		)

		return validated
	})

/**
 * Find the source branch by searching all branches for an agency.json
 * with a matching emitBranch value.
 */
const findSourceBranchByEmitBranch = (
	gitRoot: string,
	currentBranch: string,
): Effect.Effect<string | null, never, GitService | FileSystemService> =>
	Effect.gen(function* () {
		const git = yield* GitService

		// Get all local branches
		const branchesResult = yield* pipe(
			git.runGitCommand(
				["git", "branch", "--format=%(refname:short)"],
				gitRoot,
				{
					captureOutput: true,
				},
			),
			Effect.catchAll(() => Effect.succeed({ exitCode: 1, stdout: "" })),
		)

		if (branchesResult.exitCode !== 0 || !branchesResult.stdout) {
			return null
		}

		const branches = branchesResult.stdout
			.split("\n")
			.map((b) => b.trim())
			.filter((b) => b.length > 0 && b !== currentBranch)

		// Search each branch for agency.json with matching emitBranch
		for (const branch of branches) {
			const metadata = yield* readAgencyJsonFromBranch(gitRoot, branch)

			if (metadata?.emitBranch === currentBranch) {
				return branch
			}
		}

		return null
	})

/**
 * Resolve branch pair using agency.json as the first source of truth,
 * falling back to pattern-based resolution.
 *
 * Priority order:
 * 1. If on source branch (has agency.json), use its emitBranch value
 * 2. If on PR branch, search other branches for matching emitBranch
 * 3. Fall back to pattern-based resolution
 */
export const resolveBranchPairWithAgencyJson = (
	gitRoot: string,
	currentBranch: string,
	pattern: string,
): Effect.Effect<BranchPair, never, GitService | FileSystemService> =>
	Effect.gen(function* () {
		// First, try to read agency.json from the current branch
		const currentMetadata = yield* getCurrentBranchAgencyJson(gitRoot)

		if (currentMetadata?.emitBranch) {
			// We're on a source branch and know the emit branch
			return {
				sourceBranch: currentBranch,
				prBranch: currentMetadata.emitBranch,
				isOnPrBranch: false,
			}
		}

		// If we don't have agency.json on current branch, we might be on a PR branch
		// Search other branches for an agency.json with matching emitBranch
		const sourceBranch = yield* findSourceBranchByEmitBranch(
			gitRoot,
			currentBranch,
		)

		if (sourceBranch) {
			// Found the source branch via agency.json
			return {
				sourceBranch,
				prBranch: currentBranch,
				isOnPrBranch: true,
			}
		}

		// Fall back to pattern-based resolution
		return resolveBranchPair(currentBranch, pattern)
	})
