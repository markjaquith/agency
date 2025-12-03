import { Effect } from "effect"
import type { BaseCommandOptions } from "../utils/command"
import { GitService } from "../services/GitService"
import { ConfigService } from "../services/ConfigService"
import { FileSystemService } from "../services/FileSystemService"
import {
	resolveBranchPairWithAgencyJson,
	type BranchPair,
} from "../utils/pr-branch"
import highlight, { done } from "../utils/colors"
import {
	createLoggers,
	ensureGitRepo,
	ensureBranchExists,
} from "../utils/effect"

interface SwitchOptions extends BaseCommandOptions {}

export const switchBranch = (options: SwitchOptions = {}) =>
	Effect.gen(function* () {
		const { log } = createLoggers(options)

		const git = yield* GitService
		const configService = yield* ConfigService

		const gitRoot = yield* ensureGitRepo()

		// Load config
		const config = yield* configService.loadConfig()

		// Get current branch and resolve the branch pair
		const currentBranch = yield* git.getCurrentBranch(gitRoot)
		const branches: BranchPair = yield* resolveBranchPairWithAgencyJson(
			gitRoot,
			currentBranch,
			config.emitBranch,
		)
		const { sourceBranch, emitBranch, isOnEmitBranch } = branches

		if (isOnEmitBranch) {
			// We're on an emit branch, switch to source
			yield* ensureBranchExists(
				gitRoot,
				sourceBranch,
				`Source branch ${highlight.branch(sourceBranch)} does not exist`,
			)

			yield* git.checkoutBranch(gitRoot, sourceBranch)
			log(done(`Switched to source branch: ${highlight.branch(sourceBranch)}`))
		} else {
			// We're on a source branch, switch to emit branch
			yield* ensureBranchExists(
				gitRoot,
				emitBranch,
				`Emit branch ${highlight.branch(emitBranch)} does not exist. Run 'agency emit' to create it.`,
			)

			yield* git.checkoutBranch(gitRoot, emitBranch)
			log(done(`Switched to emit branch: ${highlight.branch(emitBranch)}`))
		}
	})

export const help = `
Usage: agency switch [options]

Toggle between source branch and emit branch.

This command intelligently switches between your source branch and its
corresponding emit branch:
  - If on an emit branch (e.g., main--PR), switches to source (main)
  - If on a source branch (e.g., main), switches to emit branch (main--PR)

Example:
  agency switch                  # Toggle between branches

Notes:
  - Target branch must exist
  - Uses emit branch pattern from ~/.config/agency/agency.json
  - If emit branch doesn't exist, run 'agency emit' to create it
`
