import { Effect } from "effect"
import { GitService } from "../services/GitService"
import { ConfigService } from "../services/ConfigService"
import { extractSourceBranch } from "../utils/pr-branch"
import highlight, { done } from "../utils/colors"

export interface SourceOptions {
	silent?: boolean
	verbose?: boolean
}

// Effect-based implementation
export const sourceEffect = (options: SourceOptions = {}) =>
	Effect.gen(function* () {
		const { silent = false, verbose = false } = options
		const log = silent ? () => {} : console.log
		const verboseLog = verbose && !silent ? console.log : () => {}

		const git = yield* GitService
		const configService = yield* ConfigService

		// Check if in a git repository
		const isGitRepo = yield* git.isInsideGitRepo(process.cwd())
		if (!isGitRepo) {
			return yield* Effect.fail(
				new Error(
					"Not in a git repository. Please run this command inside a git repo.",
				),
			)
		}

		// Get git root
		const gitRoot = yield* git.getGitRoot(process.cwd())

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
		const exists = yield* git.branchExists(gitRoot, sourceBranch)
		if (!exists) {
			return yield* Effect.fail(
				new Error(
					`Source branch ${highlight.branch(sourceBranch)} does not exist`,
				),
			)
		}

		// Checkout source branch
		yield* git.checkoutBranch(gitRoot, sourceBranch)

		log(done(`Switched to source branch: ${highlight.branch(sourceBranch)}`))
	})

// Backward-compatible Promise wrapper
export async function source(options: SourceOptions = {}): Promise<void> {
	const { GitServiceLive } = await import("../services/GitServiceLive")
	const { ConfigServiceLive } = await import("../services/ConfigServiceLive")

	const program = sourceEffect(options).pipe(
		Effect.provide(GitServiceLive),
		Effect.provide(ConfigServiceLive),
		Effect.catchAllDefect((defect) =>
			Effect.fail(defect instanceof Error ? defect : new Error(String(defect))),
		),
	)

	await Effect.runPromise(program)
}

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
