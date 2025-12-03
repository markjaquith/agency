import { Effect } from "effect"
import type { BaseCommandOptions } from "../utils/command"
import { GitService } from "../services/GitService"
import { ConfigService } from "../services/ConfigService"
import { FileSystemService } from "../services/FileSystemService"
import { resolveBranchPairWithAgencyJson } from "../utils/pr-branch"
import highlight, { done } from "../utils/colors"
import {
	createLoggers,
	ensureGitRepo,
	ensureBranchExists,
} from "../utils/effect"

interface SourceOptions extends BaseCommandOptions {}

export const source = (options: SourceOptions = {}) =>
	Effect.gen(function* () {
		const { log } = createLoggers(options)

		const git = yield* GitService
		const configService = yield* ConfigService

		const gitRoot = yield* ensureGitRepo()

		// Load config
		const config = yield* configService.loadConfig()

		// Get current branch and resolve the branch pair
		const currentBranch = yield* git.getCurrentBranch(gitRoot)
		const { sourceBranch, isOnEmitBranch } =
			yield* resolveBranchPairWithAgencyJson(
				gitRoot,
				currentBranch,
				config.emitBranch,
			)

		if (!isOnEmitBranch) {
			return yield* Effect.fail(
				new Error(`Not on an emit branch. Current branch: ${currentBranch}`),
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

Switch back to the source branch from an emit branch.

This command extracts the source branch name from your current emit branch name
using the configured pattern, and switches back to it.

Example:
  agency source                  # From main--PR, switch to main

Notes:
  - Must be run from an emit branch
  - Source branch must exist
  - Uses emit branch pattern from ~/.config/agency/agency.json
`
