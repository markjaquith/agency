import { Effect, DateTime } from "effect"
import { Schema } from "@effect/schema"
import type { BaseCommandOptions } from "../utils/command"
import { GitService } from "../services/GitService"
import { ConfigService } from "../services/ConfigService"
import { AgencyMetadata } from "../schemas"
import highlight from "../utils/colors"
import { createLoggers, ensureGitRepo } from "../utils/effect"

interface TasksOptions extends BaseCommandOptions {
	json?: boolean
}

/**
 * Task branch info for output
 */
interface TaskBranchInfo {
	branch: string
	template: string | null
	baseBranch: string | null
	createdAt: string | null
}

/**
 * Read agency.json metadata from a specific branch using git show.
 */
const readAgencyMetadataFromBranch = (gitRoot: string, branch: string) =>
	Effect.gen(function* () {
		const git = yield* GitService

		// Try to read agency.json from the branch using git show
		const content = yield* git.getFileAtRef(gitRoot, branch, "agency.json")

		if (!content) {
			return null
		}

		return yield* parseAgencyMetadata(content)
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

/**
 * Extract the prefix from a source branch pattern (everything before %branch%).
 */
const getSourceBranchPrefix = (pattern: string): string => {
	if (pattern.includes("%branch%")) {
		return pattern.split("%branch%")[0]!
	}
	// If no %branch% placeholder, the whole pattern is the prefix
	return pattern
}

/**
 * Find all branches that match the source branch pattern prefix
 */
const findAllTaskBranches = (gitRoot: string) =>
	Effect.gen(function* () {
		const git = yield* GitService
		const configService = yield* ConfigService

		// Get source branch pattern from config
		const config = yield* configService.loadConfig()
		const prefix = getSourceBranchPrefix(config.sourceBranchPattern)

		// Get only branches matching the prefix (fast - single git command)
		const branches = yield* git.getBranchesByPrefix(gitRoot, prefix)

		// For each matching branch, try to read agency.json for metadata
		const taskBranches: TaskBranchInfo[] = []
		for (const branch of branches) {
			const metadata = yield* readAgencyMetadataFromBranch(gitRoot, branch)

			if (metadata) {
				taskBranches.push({
					branch,
					template: metadata.template ?? null,
					baseBranch: metadata.baseBranch ?? null,
					createdAt: metadata.createdAt
						? DateTime.toDateUtc(metadata.createdAt).toISOString()
						: null,
				})
			} else {
				// Branch matches prefix but has no valid agency.json - still list it
				taskBranches.push({
					branch,
					template: null,
					baseBranch: null,
					createdAt: null,
				})
			}
		}

		return taskBranches
	})

export const tasks = (options: TasksOptions = {}) =>
	Effect.gen(function* () {
		const { json = false } = options
		const { log } = createLoggers(options)

		const gitRoot = yield* ensureGitRepo()

		// Find all branches with agency.json
		const taskBranches = yield* findAllTaskBranches(gitRoot)

		if (json) {
			// Output JSON format
			log(JSON.stringify(taskBranches, null, 2))
		} else {
			// Output human-readable format - just branch names
			if (taskBranches.length === 0) {
				log("")
				log("No task branches found.")
				log(
					`Run ${highlight.value("agency task")} to create a task on a feature branch.`,
				)
				log("")
			} else {
				for (const task of taskBranches) {
					log(task.branch)
				}
			}
		}
	})

export const help = `
Usage: agency tasks [options]

List all source branches that have agency tasks (branches matching the source
branch pattern, e.g. "agency--*").

Options:
  --json              Output as JSON (includes metadata: template, base branch, created date)

Example:
  agency tasks                   # List all task branches (names only)
  agency tasks --json            # Output as JSON with full metadata
`
