import { Effect } from "effect"
import type { BaseCommandOptions } from "../utils/command"
import { GitService } from "../services/GitService"
import { ConfigService } from "../services/ConfigService"
import {
	resolveBranchPairWithAgencyJson,
	type BranchPair,
} from "../utils/pr-branch"
import { createLoggers, ensureGitRepo } from "../utils/effect"

interface EmittedOptions extends BaseCommandOptions {}

export const emitted = (options: EmittedOptions = {}) =>
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
			config.sourceBranchPattern,
			config.emitBranch,
		)

		// Return the emit branch name (whether we're on it or not)
		log(branches.emitBranch)
	})

export const help = `
Usage: agency emitted [options]

Get the name of the emitted branch (or what it would be).

This command shows the emit branch name corresponding to your current branch:
  - If on a source branch (e.g., agency/main), shows the emit branch (e.g., main)
  - If on an emit branch (e.g., main), shows the current branch name

This is useful for scripting and automation where you need to know
the emit branch name without actually creating or switching to it.

Example:
  agency emitted                  # Show the emit branch name

Notes:
  - Does not require the emit branch to exist
  - Uses source and emit patterns from ~/.config/agency/agency.json
  - Respects emitBranch field in agency.json when present
`
