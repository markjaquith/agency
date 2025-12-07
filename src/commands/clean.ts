import { Effect } from "effect"
import { join } from "node:path"
import { Schema } from "@effect/schema"
import type { BaseCommandOptions } from "../utils/command"
import { GitService } from "../services/GitService"
import { FileSystemService } from "../services/FileSystemService"
import { ConfigService } from "../services/ConfigService"
import { AgencyMetadata } from "../schemas"
import highlight, { done } from "../utils/colors"
import { createLoggers, ensureGitRepo } from "../utils/effect"
import { extractCleanBranch, makeSourceBranchName } from "../utils/pr-branch"

interface CleanOptions extends BaseCommandOptions {
	dryRun?: boolean
	mergedInto?: string
}

/**
 * Read agency.json metadata from a repository.
 */
const readAgencyMetadata = (gitRoot: string, branch: string) =>
	Effect.gen(function* () {
		const git = yield* GitService
		const fs = yield* FileSystemService
		const metadataPath = join(gitRoot, "agency.json")

		// Checkout the branch temporarily to read its agency.json
		const currentBranch = yield* git.getCurrentBranch(gitRoot)
		const needsCheckout = currentBranch !== branch

		if (needsCheckout) {
			yield* git.checkoutBranch(gitRoot, branch)
		}

		const exists = yield* fs.exists(metadataPath)
		let metadata: AgencyMetadata | null = null

		if (exists) {
			const content = yield* fs.readFile(metadataPath)
			const data = yield* Effect.try({
				try: () => JSON.parse(content),
				catch: () => new Error("Failed to parse agency.json"),
			})

			// Validate version
			if (typeof data.version === "number" && data.version === 1) {
				// Parse and validate using Effect schema
				metadata = yield* Effect.try({
					try: () => Schema.decodeUnknownSync(AgencyMetadata)(data),
					catch: () => new Error("Invalid agency.json format"),
				}).pipe(Effect.catchAll(() => Effect.succeed(null)))
			}
		}

		// Switch back to original branch if we changed
		if (needsCheckout) {
			yield* git.checkoutBranch(gitRoot, currentBranch)
		}

		return metadata
	}).pipe(Effect.catchAll(() => Effect.succeed(null)))

/**
 * Get all local branches
 */
const getAllLocalBranches = (gitRoot: string) =>
	Effect.gen(function* () {
		const git = yield* GitService

		// Get all local branches using git branch --format
		const result = yield* git.runGitCommand(
			["git", "branch", "--format=%(refname:short)"],
			gitRoot,
			{ captureOutput: true },
		)

		if (result.exitCode !== 0) {
			return []
		}

		return result.stdout
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
	}).pipe(Effect.catchAll(() => Effect.succeed([])))

/**
 * Get all branches that have been fully merged into the specified branch
 */
const getBranchesMergedInto = (
	gitRoot: string,
	targetBranch: string,
	options: BaseCommandOptions,
) =>
	Effect.gen(function* () {
		const git = yield* GitService
		const { verboseLog } = createLoggers(options)

		verboseLog(
			`Finding branches merged into ${highlight.branch(targetBranch)}...`,
		)

		// Use git branch --merged to find all merged branches
		const result = yield* git.runGitCommand(
			["git", "branch", "--merged", targetBranch, "--format=%(refname:short)"],
			gitRoot,
			{ captureOutput: true },
		)

		if (result.exitCode !== 0) {
			return []
		}

		const mergedBranches = result.stdout
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0)

		verboseLog(`Found ${mergedBranches.length} merged branches`)
		return mergedBranches
	}).pipe(Effect.catchAll(() => Effect.succeed([])))

/**
 * Find source branches for the given branches (emit branches).
 * For each branch, check if there's a corresponding source branch by:
 * 1. Looking for branches with agency.json that has this branch as emitBranch
 * 2. Using the source branch pattern from config
 */
const findSourceBranches = (
	gitRoot: string,
	branches: readonly string[],
	sourcePattern: string,
	emitPattern: string,
	options: BaseCommandOptions,
) =>
	Effect.gen(function* () {
		const git = yield* GitService
		const { verboseLog } = createLoggers(options)

		const allBranches = yield* getAllLocalBranches(gitRoot)
		const sourceBranches: string[] = []

		verboseLog(
			`Looking for source branches for ${branches.length} emit branches...`,
		)

		// For each branch in our list, check if it's an emit branch and find its source
		for (const branch of branches) {
			// Strategy 1: Check all branches for agency.json with matching emitBranch
			for (const candidateBranch of allBranches) {
				if (candidateBranch === branch) continue

				const metadata = yield* readAgencyMetadata(gitRoot, candidateBranch)

				if (metadata?.emitBranch === branch) {
					verboseLog(
						`Found source branch ${highlight.branch(candidateBranch)} for emit branch ${highlight.branch(branch)}`,
					)
					if (!sourceBranches.includes(candidateBranch)) {
						sourceBranches.push(candidateBranch)
					}
				}
			}

			// Strategy 2: Try using the source pattern
			// If emitPattern is "%branch%", the branch name itself is the clean name
			const cleanBranch =
				emitPattern === "%branch%"
					? branch
					: extractCleanBranch(branch, emitPattern)

			if (cleanBranch) {
				const possibleSourceBranch = makeSourceBranchName(
					cleanBranch,
					sourcePattern,
				)
				const sourceExists = yield* git
					.branchExists(gitRoot, possibleSourceBranch)
					.pipe(Effect.catchAll(() => Effect.succeed(false)))

				if (sourceExists && !sourceBranches.includes(possibleSourceBranch)) {
					verboseLog(
						`Found source branch ${highlight.branch(possibleSourceBranch)} via pattern matching`,
					)
					sourceBranches.push(possibleSourceBranch)
				}
			}
		}

		verboseLog(`Found ${sourceBranches.length} source branches`)
		return sourceBranches
	})

export const clean = (options: CleanOptions = {}) =>
	Effect.gen(function* () {
		const { dryRun = false, mergedInto } = options
		const { log, verboseLog } = createLoggers(options)

		const git = yield* GitService
		const configService = yield* ConfigService
		const gitRoot = yield* ensureGitRepo()

		// Require --merged-into flag
		if (!mergedInto) {
			return yield* Effect.fail(
				new Error(
					"The --merged-into flag is required. Specify which branch to check for merged branches (e.g., --merged-into main)",
				),
			)
		}

		// Verify the target branch exists
		const targetExists = yield* git.branchExists(gitRoot, mergedInto)
		if (!targetExists) {
			return yield* Effect.fail(
				new Error(
					`Branch ${highlight.branch(mergedInto)} does not exist. Please specify a valid branch.`,
				),
			)
		}

		// Load config to get source and emit patterns
		const config = yield* configService.loadConfig()
		const sourcePattern = config.sourceBranchPattern || "agency/%branch%"
		const emitPattern = config.emitBranch || "%branch%"

		verboseLog(
			`Using source pattern: ${sourcePattern}, emit pattern: ${emitPattern}`,
		)

		// Get all branches merged into target
		const mergedBranches = yield* getBranchesMergedInto(
			gitRoot,
			mergedInto,
			options,
		)
		verboseLog(
			`Found ${mergedBranches.length} branches merged into ${highlight.branch(mergedInto)}`,
		)

		// Find source branches for the merged branches
		const sourceBranches = yield* findSourceBranches(
			gitRoot,
			mergedBranches,
			sourcePattern,
			emitPattern,
			options,
		)

		// Combine merged branches and their source branches
		const branchesToDelete = [
			...new Set([...mergedBranches, ...sourceBranches]),
		]

		// Filter out the target branch itself (we don't want to delete it)
		const filteredBranches = branchesToDelete.filter(
			(branch) => branch !== mergedInto,
		)

		if (filteredBranches.length === 0) {
			log(
				`No branches found that are merged into ${highlight.branch(mergedInto)}`,
			)
			return
		}

		// Show what will be deleted
		const branchWord = filteredBranches.length === 1 ? "branch" : "branches"
		log(
			`Found ${filteredBranches.length} ${branchWord} to delete (merged into ${highlight.branch(mergedInto)}):`,
		)
		for (const branch of filteredBranches) {
			log(`  ${highlight.branch(branch)}`)
		}

		if (dryRun) {
			log("")
			log("Dry-run mode: no branches were deleted")
			return
		}

		// Get current branch to avoid deleting it
		const currentBranch = yield* git.getCurrentBranch(gitRoot)

		// Delete all branches
		log("")
		for (const branch of filteredBranches) {
			// If we're currently on the branch, switch away first
			if (currentBranch === branch) {
				verboseLog(
					`Currently on ${highlight.branch(branch)}, switching to ${highlight.branch(mergedInto)}`,
				)
				yield* git.checkoutBranch(gitRoot, mergedInto)
			}

			verboseLog(`Deleting ${highlight.branch(branch)}...`)
			yield* git.deleteBranch(gitRoot, branch, true)
		}

		const deletedBranchWord =
			filteredBranches.length === 1 ? "branch" : "branches"
		log(done(`Deleted ${filteredBranches.length} ${deletedBranchWord}`))
	})

export const help = `
Usage: agency clean --merged-into <branch> [options]

Delete all branches that have been fully merged into a specified branch, 
along with their corresponding source branches.

This command is useful for cleaning up branches after they've been merged.
It will:
1. Find all branches fully merged into the specified branch
2. Find the corresponding source branches (which won't show as merged due to emit filtering)
3. Delete both the merged branches and their source branches

The --merged-into flag is REQUIRED to prevent accidental deletion of branches.

Options:
  --merged-into <branch>  Branch to check against (e.g., main, origin/main) [REQUIRED]
  --dry-run              Show what would be deleted without actually deleting

Safety:
  - By default, this command deletes branches
  - Use --dry-run to preview what would be deleted without making changes
  - If currently on a branch that will be deleted, switches to the target branch first
  - Uses force delete (git branch -D) to ensure branches are deleted

Examples:
  agency clean --merged-into main           # Delete branches merged into main
  agency clean --merged-into main --dry-run # Preview what would be deleted
  agency clean --merged-into origin/main    # Delete branches merged into origin/main
`
