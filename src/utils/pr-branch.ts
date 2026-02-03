/**
 * Utilities for working with source and emit branch names and patterns
 */

import { Effect, pipe } from "effect"
import { FileSystemService } from "../services/FileSystemService"
import { GitService } from "../services/GitService"
import { AgencyMetadataService } from "../services/AgencyMetadataService"
import { AgencyMetadata } from "../schemas"
import { Schema } from "@effect/schema"

/**
 * Generate a source branch name by applying a pattern to a clean branch name.
 * If pattern contains %branch%, it replaces it with the branch name.
 * Otherwise, treats the pattern as a prefix.
 *
 * @example
 * makeSourceBranchName("main", "agency--%branch%") // "agency--main"
 * makeSourceBranchName("feature-foo", "wip/%branch%") // "wip/feature-foo"
 * makeSourceBranchName("main", "agency--") // "agency--main"
 */
export function makeSourceBranchName(
	cleanBranch: string,
	pattern: string,
): string {
	if (pattern.includes("%branch%")) {
		return pattern.replace("%branch%", cleanBranch)
	}

	// If no %branch% placeholder, treat pattern as prefix
	return pattern + cleanBranch
}

/**
 * Extract the clean branch name from a source branch name using a pattern.
 * Returns null if the source branch name doesn't match the pattern.
 *
 * @example
 * extractCleanBranch("agency--main", "agency--%branch%") // "main"
 * extractCleanBranch("wip/feature-foo", "wip/%branch%") // "feature-foo"
 * extractCleanBranch("agency--main", "agency--") // "main"
 * extractCleanBranch("main", "agency--%branch%") // null
 */
export function extractCleanBranch(
	sourceBranchName: string,
	pattern: string,
): string | null {
	if (pattern.includes("%branch%")) {
		// Split pattern into prefix and suffix around %branch%
		const parts = pattern.split("%branch%")
		if (parts.length !== 2) return null

		const prefix = parts[0]!
		const suffix = parts[1]!

		// Check if source branch name matches the pattern
		if (
			!sourceBranchName.startsWith(prefix) ||
			!sourceBranchName.endsWith(suffix)
		) {
			return null
		}

		// Extract the clean branch name by removing prefix and suffix
		const cleanBranch = sourceBranchName.slice(
			prefix.length,
			sourceBranchName.length - suffix.length,
		)

		// Ensure we extracted something (not empty string)
		return cleanBranch.length > 0 ? cleanBranch : null
	} else {
		// Pattern is a prefix - check if branch starts with it
		if (!sourceBranchName.startsWith(pattern)) {
			return null
		}

		const cleanBranch = sourceBranchName.slice(pattern.length)
		return cleanBranch.length > 0 ? cleanBranch : null
	}
}

/**
 * Generate an emit branch name from a clean branch name and emit pattern.
 * If pattern is "%branch%", returns the clean branch name unchanged.
 * Otherwise, applies the pattern the same way as makeSourceBranchName.
 *
 * @example
 * makeEmitBranchName("main", "%branch%") // "main"
 * makeEmitBranchName("feature-foo", "%branch%--PR") // "feature-foo--PR"
 * makeEmitBranchName("feature-foo", "PR/%branch%") // "PR/feature-foo"
 */
export function makeEmitBranchName(
	cleanBranch: string,
	emitPattern: string,
): string {
	// Special case: "%branch%" means use clean branch name as-is
	if (emitPattern === "%branch%") {
		return cleanBranch
	}

	if (emitPattern.includes("%branch%")) {
		return emitPattern.replace("%branch%", cleanBranch)
	}

	// If no %branch% placeholder, treat pattern as suffix
	return cleanBranch + emitPattern
}

/**
 * Extract the clean branch name from an emit branch name using an emit pattern.
 * Returns null if the emit branch name doesn't match the pattern.
 *
 * @example
 * extractCleanFromEmit("main", "%branch%") // "main"
 * extractCleanFromEmit("feature-foo--PR", "%branch%--PR") // "feature-foo"
 * extractCleanFromEmit("PR/feature-foo", "PR/%branch%") // "feature-foo"
 * extractCleanFromEmit("main", "%branch%--PR") // null
 */
export function extractCleanFromEmit(
	emitBranchName: string,
	emitPattern: string,
): string | null {
	// Special case: "%branch%" means emit branch is the clean branch name
	if (emitPattern === "%branch%") {
		return emitBranchName
	}

	if (emitPattern.includes("%branch%")) {
		// Split pattern into prefix and suffix around %branch%
		const parts = emitPattern.split("%branch%")
		if (parts.length !== 2) return null

		const prefix = parts[0]!
		const suffix = parts[1]!

		// Check if emit branch name matches the pattern
		if (
			!emitBranchName.startsWith(prefix) ||
			!emitBranchName.endsWith(suffix)
		) {
			return null
		}

		// Extract the clean branch name by removing prefix and suffix
		const cleanBranch = emitBranchName.slice(
			prefix.length,
			emitBranchName.length - suffix.length,
		)

		// Ensure we extracted something (not empty string)
		return cleanBranch.length > 0 ? cleanBranch : null
	} else {
		// Pattern is a suffix - check if branch ends with it
		if (!emitBranchName.endsWith(emitPattern)) {
			return null
		}

		const cleanBranch = emitBranchName.slice(0, -emitPattern.length)
		return cleanBranch.length > 0 ? cleanBranch : null
	}
}

/**
 * Result of resolving a branch pair (source and emit branches).
 */
export interface BranchPair {
	/** The source branch name (with source pattern applied) */
	sourceBranch: string
	/** The emit branch name (clean or with emit pattern) */
	emitBranch: string
	/** Whether the current branch is the emit branch */
	isOnEmitBranch: boolean
}

/**
 * Resolve the source and emit branch names from a current branch and patterns.
 * This determines whether we're on an emit branch or source branch and provides
 * both branch names.
 *
 * @example
 * resolveBranchPair("agency--main", "agency--%branch%", "%branch%")
 * // { sourceBranch: "agency--main", emitBranch: "main", isOnEmitBranch: false }
 *
 * resolveBranchPair("main", "agency--%branch%", "%branch%")
 * // { sourceBranch: "agency--main", emitBranch: "main", isOnEmitBranch: true }
 */
function resolveBranchPair(
	currentBranch: string,
	sourcePattern: string,
	emitPattern: string,
): BranchPair {
	// First, try to extract clean branch from source pattern
	const cleanFromSource = extractCleanBranch(currentBranch, sourcePattern)

	if (cleanFromSource) {
		// Current branch is a source branch (matches source pattern)
		return {
			sourceBranch: currentBranch,
			emitBranch: makeEmitBranchName(cleanFromSource, emitPattern),
			isOnEmitBranch: false,
		}
	}

	// If emit pattern is not just "%branch%" (which would match anything),
	// check if current branch matches the emit pattern
	if (emitPattern !== "%branch%") {
		const cleanFromEmit = extractCleanFromEmit(currentBranch, emitPattern)

		if (cleanFromEmit) {
			// Current branch is an emit branch (matches emit pattern)
			return {
				sourceBranch: makeSourceBranchName(cleanFromEmit, sourcePattern),
				emitBranch: currentBranch,
				isOnEmitBranch: true,
			}
		}
	}

	// If neither pattern matches (or emit pattern is "%branch%"), this is a
	// "legacy" branch that doesn't follow the new naming convention.
	// Treat it as a source branch where the branch name itself is the clean name.
	return {
		sourceBranch: currentBranch,
		emitBranch: makeEmitBranchName(currentBranch, emitPattern),
		isOnEmitBranch: false,
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
		const metadataService = yield* AgencyMetadataService
		return yield* metadataService.readFromBranch(gitRoot, branch)
	}).pipe(Effect.provide(AgencyMetadataService.Default))

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
		const metadataService = yield* AgencyMetadataService
		return yield* metadataService.readFromDisk(gitRoot)
	}).pipe(Effect.provide(AgencyMetadataService.Default))

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
		const branches = yield* pipe(
			git.getAllLocalBranches(gitRoot),
			Effect.map((allBranches) =>
				allBranches.filter((b) => b !== currentBranch),
			),
			Effect.catchAll(() => Effect.succeed([] as readonly string[])),
		)

		if (branches.length === 0) {
			return null
		}

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
 * Strategy 1: Try to resolve branch pair from current branch's agency.json.
 * If current branch has agency.json with emitBranch that differs from current branch,
 * we're on a source branch. If emitBranch equals current branch, we're on the emit branch.
 */
const tryResolveFromCurrentAgencyJson = (
	gitRoot: string,
	currentBranch: string,
): Effect.Effect<BranchPair | null, never, GitService | FileSystemService> =>
	Effect.gen(function* () {
		const currentMetadata = yield* getCurrentBranchAgencyJson(gitRoot)

		if (currentMetadata?.emitBranch) {
			// If emitBranch equals current branch, we're actually ON the emit branch,
			// not the source branch. This can happen when skipFilter is used in tests
			// and the agency.json is copied to the emit branch with emitBranch intact.
			if (currentMetadata.emitBranch === currentBranch) {
				// Return null to let Strategy 2 find the actual source branch
				return null
			}
			return {
				sourceBranch: currentBranch,
				emitBranch: currentMetadata.emitBranch,
				isOnEmitBranch: false,
			}
		}

		return null
	})

/**
 * Strategy 2: Search other branches for agency.json with matching emitBranch.
 * If found, we're on an emit branch.
 */
const tryResolveFromOtherBranchAgencyJson = (
	gitRoot: string,
	currentBranch: string,
): Effect.Effect<BranchPair | null, never, GitService | FileSystemService> =>
	Effect.gen(function* () {
		const sourceBranch = yield* findSourceBranchByEmitBranch(
			gitRoot,
			currentBranch,
		)

		if (sourceBranch) {
			return {
				sourceBranch,
				emitBranch: currentBranch,
				isOnEmitBranch: true,
			}
		}

		return null
	})

/**
 * Strategy 3: For clean emit patterns ("%branch%"), check if a patterned source branch exists.
 * If so, we're on an emit branch.
 */
const tryResolveFromPatternedSourceBranch = (
	gitRoot: string,
	currentBranch: string,
	sourcePattern: string,
	emitPattern: string,
): Effect.Effect<BranchPair | null, never, GitService | FileSystemService> =>
	Effect.gen(function* () {
		// Only applies when emit pattern is "%branch%" (clean emit branches)
		if (emitPattern !== "%branch%") {
			return null
		}

		const git = yield* GitService
		const possibleSourceBranch = makeSourceBranchName(
			currentBranch,
			sourcePattern,
		)

		const sourceExists = yield* pipe(
			git.branchExists(gitRoot, possibleSourceBranch),
			Effect.catchAll(() => Effect.succeed(false)),
		)

		if (sourceExists) {
			return {
				sourceBranch: possibleSourceBranch,
				emitBranch: currentBranch,
				isOnEmitBranch: true,
			}
		}

		return null
	})

/**
 * Resolve branch pair using agency.json as the first source of truth,
 * falling back to pattern-based resolution.
 *
 * Resolution strategies (in priority order):
 * 1. Current branch has agency.json with emitBranch -> we're on source branch
 * 2. Another branch has agency.json pointing to current branch -> we're on emit branch
 * 3. Clean emit pattern and patterned source branch exists -> we're on emit branch
 * 4. Fall back to pattern-based resolution
 */
export const resolveBranchPairWithAgencyJson = (
	gitRoot: string,
	currentBranch: string,
	sourcePattern: string,
	emitPattern: string,
): Effect.Effect<BranchPair, never, GitService | FileSystemService> =>
	Effect.gen(function* () {
		// Strategy 1: Check current branch's agency.json
		const fromCurrentAgencyJson = yield* tryResolveFromCurrentAgencyJson(
			gitRoot,
			currentBranch,
		)
		if (fromCurrentAgencyJson) {
			return fromCurrentAgencyJson
		}

		// Strategy 2: Search other branches for matching agency.json
		const fromOtherBranchAgencyJson =
			yield* tryResolveFromOtherBranchAgencyJson(gitRoot, currentBranch)
		if (fromOtherBranchAgencyJson) {
			return fromOtherBranchAgencyJson
		}

		// Strategy 3: Check for patterned source branch (clean emit patterns only)
		const fromPatternedSource = yield* tryResolveFromPatternedSourceBranch(
			gitRoot,
			currentBranch,
			sourcePattern,
			emitPattern,
		)
		if (fromPatternedSource) {
			return fromPatternedSource
		}

		// Strategy 4: Fall back to pattern-based resolution
		return resolveBranchPair(currentBranch, sourcePattern, emitPattern)
	})

// Legacy function names for backward compatibility
// These will be updated as we migrate the codebase

/**
 * @deprecated Use makeEmitBranchName instead. This function now creates emit branches,
 * not PR branches with suffixes.
 */
export function makePrBranchName(branchName: string, pattern: string): string {
	return makeEmitBranchName(branchName, pattern)
}

/**
 * @deprecated Use extractCleanFromEmit instead. Extracts clean branch from emit branch.
 */
export function extractSourceBranch(
	emitBranchName: string,
	pattern: string,
): string | null {
	return extractCleanFromEmit(emitBranchName, pattern)
}
