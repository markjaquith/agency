import { Effect } from "effect"
import type { BaseCommandOptions } from "../utils/command"
import { GitService } from "../services/GitService"
import { ConfigService } from "../services/ConfigService"
import { resolveBranchPairWithAgencyJson } from "../utils/pr-branch"
import { ensureGitRepo } from "../utils/effect"

interface PrOptions extends BaseCommandOptions {
	/** Arguments to pass to gh pr (subcommand and flags) */
	args: string[]
}

export const pr = (options: PrOptions) =>
	Effect.gen(function* () {
		const git = yield* GitService
		const configService = yield* ConfigService

		const gitRoot = yield* ensureGitRepo()

		// Load config
		const config = yield* configService.loadConfig()

		// Get current branch and resolve the branch pair
		const currentBranch = yield* git.getCurrentBranch(gitRoot)
		const branches = yield* resolveBranchPairWithAgencyJson(
			gitRoot,
			currentBranch,
			config.sourceBranchPattern,
			config.emitBranch,
		)

		// Build the gh pr command with the emit branch
		const ghArgs = ["gh", "pr", ...options.args, branches.emitBranch]

		// Run gh pr with stdio inherited so output goes directly to terminal
		const exitCode = yield* Effect.tryPromise({
			try: async () => {
				const proc = Bun.spawn(ghArgs, {
					cwd: gitRoot,
					stdin: "inherit",
					stdout: "inherit",
					stderr: "inherit",
				})
				return proc.exited
			},
			catch: (error) =>
				new Error(
					`Failed to run gh pr: ${error instanceof Error ? error.message : String(error)}`,
				),
		})

		if (exitCode !== 0) {
			return yield* Effect.fail(
				new Error(`gh pr command exited with code ${exitCode}`),
			)
		}
	})

export const help = `
Usage: agency pr <subcommand> [flags]

Wrapper for 'gh pr' that automatically appends the emitted branch name.

This command passes all arguments to 'gh pr' with the emitted branch name
appended, making it easy to work with PRs for your feature branch without
needing to remember or type the emit branch name.

Examples:
  agency pr view --web              # gh pr view --web <emit-branch>
  agency pr checks                  # gh pr checks <emit-branch>
  agency pr status                  # gh pr status <emit-branch>

Notes:
  - Requires gh CLI to be installed and authenticated
  - Uses source and emit patterns from ~/.config/agency/agency.json
  - Respects emitBranch field in agency.json when present
`
