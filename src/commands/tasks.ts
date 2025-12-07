import { Effect, DateTime } from "effect"
import { Schema } from "@effect/schema"
import type { BaseCommandOptions } from "../utils/command"
import { GitService } from "../services/GitService"
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

/**
 * Find all branches that contain an agency.json file
 */
const findAllTaskBranches = (gitRoot: string) =>
	Effect.gen(function* () {
		const git = yield* GitService

		// Get all local branches
		const branchesResult = yield* git.runGitCommand(
			["git", "branch", "--format=%(refname:short)"],
			gitRoot,
			{ captureOutput: true },
		)

		if (branchesResult.exitCode !== 0 || !branchesResult.stdout) {
			return []
		}

		const branches = branchesResult.stdout
			.split("\n")
			.map((b) => b.trim())
			.filter((b) => b.length > 0)

		// For each branch, try to read agency.json
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

List all source branches that have agency tasks (branches containing agency.json).

This command searches through all local branches and displays those that have
been initialized with 'agency task'.

Options:
  --json              Output as JSON (includes metadata: template, base branch, created date)

Example:
  agency tasks                   # List all task branches (names only)
  agency tasks --json            # Output as JSON with full metadata
`
