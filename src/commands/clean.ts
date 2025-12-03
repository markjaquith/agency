import { Effect } from "effect"
import { join } from "node:path"
import { Schema } from "@effect/schema"
import type { BaseCommandOptions } from "../utils/command"
import { GitService } from "../services/GitService"
import { FileSystemService } from "../services/FileSystemService"
import { AgencyMetadata } from "../schemas"
import highlight, { done, plural } from "../utils/colors"
import { createLoggers, ensureGitRepo } from "../utils/effect"

interface CleanOptions extends BaseCommandOptions {
	dryRun?: boolean
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

export const clean = (options: CleanOptions = {}) =>
	Effect.gen(function* () {
		const { dryRun = false } = options
		const { log, verboseLog } = createLoggers(options)

		const git = yield* GitService
		const gitRoot = yield* ensureGitRepo()

		verboseLog("Scanning for emit branches...")

		// Get all local branches
		const allBranches = yield* getAllLocalBranches(gitRoot)
		verboseLog(
			`Found ${allBranches.length} local ${allBranches.length === 1 ? "branch" : "branches"}`,
		)

		// Find emit branches by checking each branch for agency.json with emitBranch key
		const emitBranches: Array<{ branch: string; emitBranch: string }> = []

		for (const branch of allBranches) {
			verboseLog(`Checking ${highlight.branch(branch)}...`)
			const metadata = yield* readAgencyMetadata(gitRoot, branch)

			if (metadata?.emitBranch) {
				// Check if the emit branch actually exists
				const emitBranchExists = yield* git.branchExists(
					gitRoot,
					metadata.emitBranch,
				)

				if (emitBranchExists) {
					emitBranches.push({
						branch,
						emitBranch: metadata.emitBranch,
					})
					verboseLog(
						`  Found emit branch: ${highlight.branch(metadata.emitBranch)}`,
					)
				}
			}
		}

		if (emitBranches.length === 0) {
			log("No emit branches found to clean")
			return
		}

		// Show what will be deleted
		const branchWord = emitBranches.length === 1 ? "branch" : "branches"
		log(`Found ${emitBranches.length} emit ${branchWord} to delete:`)
		for (const { branch, emitBranch } of emitBranches) {
			log(
				`  ${highlight.branch(emitBranch)} (from ${highlight.branch(branch)})`,
			)
		}

		if (dryRun) {
			log("")
			log("Dry-run mode: no branches were deleted")
			return
		}

		// Get current branch to avoid deleting it
		const currentBranch = yield* git.getCurrentBranch(gitRoot)

		// Delete all emit branches
		log("")
		for (const { branch, emitBranch } of emitBranches) {
			// If we're currently on the emit branch, switch to source first
			if (currentBranch === emitBranch) {
				verboseLog(
					`Switching from ${highlight.branch(emitBranch)} to ${highlight.branch(branch)}`,
				)
				yield* git.checkoutBranch(gitRoot, branch)
			}

			verboseLog(`Deleting ${highlight.branch(emitBranch)}...`)
			yield* git.deleteBranch(gitRoot, emitBranch, true)
		}

		const deletedBranchWord = emitBranches.length === 1 ? "branch" : "branches"
		log(done(`Deleted ${emitBranches.length} emit ${deletedBranchWord}`))
	})

export const help = `
Usage: agency clean [options]

Delete all emit branches found in the repository.

This command scans all local branches for agency.json files that contain an
emitBranch key. If the emit branch referenced exists, it will be deleted.

This is useful for cleaning up emit branches after they've been merged or
are no longer needed.

Options:
  --dry-run         Show what would be deleted without actually deleting

Safety:
  - By default, this command deletes emit branches
  - Use --dry-run to preview what would be deleted without making changes
  - If currently on an emit branch, it will switch to the source branch first
  - Uses force delete (git branch -D) to ensure branches are deleted even if not fully merged

Example:
  agency clean                   # Delete all emit branches
  agency clean --dry-run         # Show what would be deleted
`
