import { Effect } from "effect"
import type { BaseCommandOptions } from "../utils/command"
import { GitService } from "../services/GitService"
import { ConfigService } from "../services/ConfigService"
import { extractSourceBranch } from "../utils/pr-branch"
import highlight, { done } from "../utils/colors"
import {
	createLoggers,
	ensureGitRepo,
	ensureBranchExists,
} from "../utils/effect"

interface SourceOptions extends BaseCommandOptions {}

export const source = (options: SourceOptions = {}) =>
	Effect.gen(function* () {
		const { log, verboseLog } = createLoggers(options)

		const git = yield* GitService
		const configService = yield* ConfigService

		const gitRoot = yield* ensureGitRepo()

		// Load config
		const config = yield* configService.loadConfig()

		// Get current branch
		const currentBranch = yield* git.getCurrentBranch(gitRoot)

		// Extract source branch name
		const sourceBranch = extractSourceBranch(currentBranch, config.prBranch)

		if (!sourceBranch) {
			return yield* Effect.fail(
				new Error(`Not on a PR branch. Current branch: ${currentBranch}`),
			)
		}

		// Check if source branch exists
		yield* ensureBranchExists(
			gitRoot,
			sourceBranch,
			`Source branch ${highlight.branch(sourceBranch)} does not exist`,
		)

		// Checkout source branch
		yield* git.checkoutBranch(gitRoot, sourceBranch)

		log(done(`Switched to source branch: ${highlight.branch(sourceBranch)}`))
	})

export const help = `
Usage: agency source [options]

Switch back to the source branch from a PR branch.

This command extracts the source branch name from your current PR branch name
using the configured pattern, and switches back to it.

Example:
  agency source                  # From main--PR, switch to main

Notes:
  - Must be run from a PR branch
  - Source branch must exist
  - Uses PR branch pattern from ~/.config/agency/agency.json
`
