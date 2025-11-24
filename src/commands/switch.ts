import { Effect } from "effect"
import type { BaseCommandOptions } from "../utils/command"
import { GitService } from "../services/GitService"
import { ConfigService } from "../services/ConfigService"
import { extractSourceBranch, makePrBranchName } from "../utils/pr-branch"
import highlight, { done } from "../utils/colors"
import { createLoggers, ensureGitRepo } from "../utils/effect"

interface SwitchOptions extends BaseCommandOptions {}

export const switchBranch = (options: SwitchOptions = {}) =>
	Effect.gen(function* () {
		const { log } = createLoggers(options)

		const git = yield* GitService
		const configService = yield* ConfigService

		const gitRoot = yield* ensureGitRepo()

		// Load config
		const config = yield* configService.loadConfig()

		// Get current branch
		const currentBranch = yield* git.getCurrentBranch(gitRoot)

		// Try to extract source branch (are we on a PR branch?)
		const sourceBranch = extractSourceBranch(currentBranch, config.prBranch)

		if (sourceBranch) {
			// We're on a PR branch, switch to source
			const exists = yield* git.branchExists(gitRoot, sourceBranch)
			if (!exists) {
				return yield* Effect.fail(
					new Error(
						`Source branch ${highlight.branch(sourceBranch)} does not exist`,
					),
				)
			}

			yield* git.checkoutBranch(gitRoot, sourceBranch)
			log(done(`Switched to source branch: ${highlight.branch(sourceBranch)}`))
		} else {
			// We're on a source branch, switch to PR branch
			const prBranch = makePrBranchName(currentBranch, config.prBranch)

			const exists = yield* git.branchExists(gitRoot, prBranch)
			if (!exists) {
				return yield* Effect.fail(
					new Error(
						`PR branch ${highlight.branch(prBranch)} does not exist. Run 'agency pr' to create it.`,
					),
				)
			}

			yield* git.checkoutBranch(gitRoot, prBranch)
			log(done(`Switched to PR branch: ${highlight.branch(prBranch)}`))
		}
	})

export const help = `
Usage: agency switch [options]

Toggle between source branch and PR branch.

This command intelligently switches between your source branch and its
corresponding PR branch:
  - If on a PR branch (e.g., main--PR), switches to source (main)
  - If on a source branch (e.g., main), switches to PR branch (main--PR)

Example:
  agency switch                  # Toggle between branches

Notes:
  - Target branch must exist
  - Uses PR branch pattern from ~/.config/agency/agency.json
  - If PR branch doesn't exist, run 'agency pr' to create it
`
