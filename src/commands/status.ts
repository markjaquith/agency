import { Effect, DateTime } from "effect"
import { join } from "node:path"
import { Schema } from "@effect/schema"
import type { BaseCommandOptions } from "../utils/command"
import { GitService } from "../services/GitService"
import { ConfigService } from "../services/ConfigService"
import { FileSystemService } from "../services/FileSystemService"
import { resolveBranchPairWithAgencyJson } from "../utils/pr-branch"
import { AgencyMetadata } from "../schemas"
import highlight, { plural } from "../utils/colors"
import { createLoggers, ensureGitRepo, getTemplateName } from "../utils/effect"

interface StatusOptions extends BaseCommandOptions {
	json?: boolean
}

/**
 * Branch type for status output
 */
type BranchType = "source" | "emit" | "neither"

/**
 * Base files that are always in the backpack
 */
const BASE_BACKPACK_FILES = ["TASK.md", "AGENCY.md", "agency.json"]

/**
 * Status data structure returned by the status command
 */
interface StatusData {
	initialized: boolean
	branchType: BranchType
	currentBranch: string
	sourceBranch: string | null
	emitBranch: string | null
	correspondingBranchExists: boolean
	template: string | null
	managedFiles: string[]
	baseBranch: string | null
	createdAt: string | null
}

/**
 * Read agency.json metadata from the current working directory.
 */
const readAgencyMetadataFromDisk = (gitRoot: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystemService
		const metadataPath = join(gitRoot, "agency.json")

		const exists = yield* fs.exists(metadataPath)
		if (!exists) {
			return null
		}

		const content = yield* fs.readFile(metadataPath)
		return yield* parseAgencyMetadata(content)
	}).pipe(Effect.catchAll(() => Effect.succeed(null)))

/**
 * Read agency.json metadata from a specific branch using git show.
 */
const readAgencyMetadataFromBranch = (gitRoot: string, branch: string) =>
	Effect.gen(function* () {
		const git = yield* GitService

		// Try to read agency.json from the branch using git show
		const result = yield* git.runGitCommand(
			["git", "show", `${branch}:agency.json`],
			gitRoot,
			{ captureOutput: true },
		)

		if (result.exitCode !== 0 || !result.stdout) {
			return null
		}

		return yield* parseAgencyMetadata(result.stdout)
	}).pipe(Effect.catchAll(() => Effect.succeed(null)))

/**
 * Parse and validate agency.json content.
 */
const parseAgencyMetadata = (content: string) =>
	Effect.gen(function* () {
		const data = yield* Effect.try({
			try: () => JSON.parse(content),
			catch: () => new Error("Failed to parse agency.json"),
		})

		// Validate version
		if (typeof data.version !== "number" || data.version !== 1) {
			return null
		}

		// Parse and validate using Effect schema
		const metadata = yield* Effect.try({
			try: () => Schema.decodeUnknownSync(AgencyMetadata)(data),
			catch: () => new Error("Invalid agency.json format"),
		})

		return metadata
	}).pipe(Effect.catchAll(() => Effect.succeed(null)))

export const status = (options: StatusOptions = {}) =>
	Effect.gen(function* () {
		const { json = false } = options
		const { log } = createLoggers(options)

		const git = yield* GitService
		const configService = yield* ConfigService

		const gitRoot = yield* ensureGitRepo()

		// Load config for emit branch pattern
		const config = yield* configService.loadConfig()

		// Get current branch
		const currentBranch = yield* git.getCurrentBranch(gitRoot)

		// Resolve branch pair to determine if we're on source or emit branch
		const branches = yield* resolveBranchPairWithAgencyJson(
			gitRoot,
			currentBranch,
			config.emitBranch,
		)
		const { sourceBranch, emitBranch, isOnEmitBranch } = branches

		// Check if agency is initialized
		// If on emit branch, read agency.json from source branch; otherwise read from disk
		const metadata = isOnEmitBranch
			? yield* readAgencyMetadataFromBranch(gitRoot, sourceBranch)
			: yield* readAgencyMetadataFromDisk(gitRoot)
		const initialized = metadata !== null

		// Determine branch type
		let branchType: BranchType = "neither"
		if (initialized) {
			branchType = isOnEmitBranch ? "emit" : "source"
		}

		// Check if the corresponding branch exists
		const correspondingBranch = isOnEmitBranch ? sourceBranch : emitBranch
		const correspondingBranchExists = yield* git.branchExists(
			gitRoot,
			correspondingBranch,
		)

		// Get template name from git config
		const template = yield* getTemplateName(gitRoot)

		// Build the complete backpack (all files carried in/out)
		const backpackFiles = metadata
			? [...BASE_BACKPACK_FILES, ...metadata.injectedFiles]
			: []

		// Build status data
		const statusData: StatusData = {
			initialized,
			branchType,
			currentBranch,
			sourceBranch: isOnEmitBranch ? sourceBranch : currentBranch,
			emitBranch: isOnEmitBranch ? currentBranch : emitBranch,
			correspondingBranchExists,
			template,
			managedFiles: backpackFiles,
			baseBranch: metadata?.baseBranch ?? null,
			createdAt: metadata?.createdAt
				? DateTime.toDateUtc(metadata.createdAt).toISOString()
				: null,
		}

		if (json) {
			// Output JSON format
			log(JSON.stringify(statusData, null, 2))
		} else {
			// Output human-readable format with highlighting
			log("")

			if (!initialized) {
				// Not initialized - show minimal info
				log(
					`Not initialized (run ${highlight.value("agency task")} to initialize)`,
				)
				log(`Current branch: ${highlight.branch(currentBranch)}`)
				if (template) {
					log(`Template: ${highlight.template(template)}`)
				}
			} else {
				// Initialized - show full status
				log(`Current branch: ${highlight.branch(currentBranch)}`)

				// Branch type
				const branchTypeDisplay = isOnEmitBranch
					? "Emit branch"
					: "Source branch"
				log(`Branch type: ${branchTypeDisplay}`)

				// Show corresponding branch only if it exists
				if (correspondingBranchExists) {
					if (isOnEmitBranch) {
						log(`Source branch: ${highlight.branch(statusData.sourceBranch!)}`)
					} else {
						log(`Emit branch: ${highlight.branch(statusData.emitBranch!)}`)
					}
				}

				// Template
				if (template) {
					log(`Template: ${highlight.template(template)}`)
				}

				// Base branch
				if (metadata?.baseBranch) {
					log(`Base branch: ${highlight.branch(metadata.baseBranch)}`)
				}

				// Backpack (files carried into the job and will leave with)
				if (backpackFiles.length > 0) {
					log(`Backpack:`)
					for (const file of backpackFiles) {
						log(`  ${highlight.file(file)}`)
					}
				}

				// Created at
				if (metadata?.createdAt) {
					const date = DateTime.toDateUtc(metadata.createdAt)
					log(`Created: ${date.toLocaleString()}`)
				}
			}

			log("")
		}
	})

export const help = `
Usage: agency status [options]

Display the current status of the agency setup in this repository.

Information shown:
  - Whether agency is initialized (agency.json exists)
  - Current branch and branch type (source, emit, or neither)
  - Source and emit branch names
  - Whether the corresponding branch exists
  - Configured template name
  - Backpack (files carried in and filtered during emit)
  - Base branch and creation timestamp

Options:
  --json              Output status as JSON for scripting

Example:
  agency status                  # Show human-readable status
  agency status --json           # Output as JSON
`
