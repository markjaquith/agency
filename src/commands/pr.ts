import { Effect } from "effect"
import type { BaseCommandOptions } from "../utils/command"
import { GitService } from "../services/GitService"
import { ConfigService } from "../services/ConfigService"
import { resolveAgencyBranchPairWithAgencyJson } from "../utils/pr-branch"
import { ensureGitRepo } from "../utils/effect"

interface PrOptions extends BaseCommandOptions {
	/** Arguments to pass to gh pr (subcommand and flags) */
	args: string[]
}

const PR_SUBCOMMANDS_WITH_OPTIONAL_SELECTOR = new Set([
	"checkout",
	"checks",
	"close",
	"comment",
	"diff",
	"edit",
	"lock",
	"merge",
	"ready",
	"reopen",
	"review",
	"unlock",
	"update-branch",
	"view",
])

const GH_PR_FLAGS_WITH_VALUE = new Set([
	"--add-assignee",
	"--add-label",
	"--add-project",
	"--add-reviewer",
	"--app",
	"--assignee",
	"--author",
	"--base",
	"--body",
	"--body-file",
	"--head",
	"--hostname",
	"--json",
	"--jq",
	"--label",
	"--limit",
	"--match-head-commit",
	"--milestone",
	"--project",
	"--remove-assignee",
	"--remove-label",
	"--remove-project",
	"--remove-reviewer",
	"--repo",
	"--reviewer",
	"--search",
	"--state",
	"--template",
	"--title",
])

const GH_PR_SHORT_FLAGS_WITH_VALUE = new Set([
	"-A",
	"-B",
	"-H",
	"-L",
	"-R",
	"-a",
	"-b",
	"-l",
	"-m",
	"-p",
	"-q",
	"-r",
	"-s",
	"-t",
])

const hasExplicitPrSelector = (args: readonly string[]): boolean => {
	const subcommandArgs = args.slice(1)

	for (let i = 0; i < subcommandArgs.length; i++) {
		const arg = subcommandArgs[i]

		if (!arg) {
			continue
		}

		if (arg === "--") {
			return subcommandArgs.slice(i + 1).some(Boolean)
		}

		if (arg.startsWith("--")) {
			const flagName = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg

			if (!arg.includes("=") && GH_PR_FLAGS_WITH_VALUE.has(flagName)) {
				i++
			}

			continue
		}

		if (arg.startsWith("-") && arg.length > 1) {
			if (GH_PR_SHORT_FLAGS_WITH_VALUE.has(arg)) {
				i++
			}

			continue
		}

		return true
	}

	return false
}

const shouldAppendEmitBranch = (args: readonly string[]): boolean => {
	const subcommand = args[0]

	return (
		typeof subcommand === "string" &&
		PR_SUBCOMMANDS_WITH_OPTIONAL_SELECTOR.has(subcommand) &&
		!hasExplicitPrSelector(args)
	)
}

export const pr = (options: PrOptions) =>
	Effect.gen(function* () {
		const git = yield* GitService
		const configService = yield* ConfigService

		const gitRoot = yield* ensureGitRepo()

		// Load config
		const config = yield* configService.loadConfig()

		// Get current branch and resolve the branch pair when agency context exists
		const currentBranch = yield* git.getCurrentBranch(gitRoot)
		const branches = yield* resolveAgencyBranchPairWithAgencyJson(
			gitRoot,
			currentBranch,
			config.sourceBranchPattern,
			config.emitBranch,
		)

		// Build the gh pr command with the emit branch only when gh accepts a selector.
		const ghArgs =
			branches && shouldAppendEmitBranch(options.args)
				? ["gh", "pr", ...options.args, branches.emitBranch]
				: ["gh", "pr", ...options.args]

		// Run gh pr with stdio inherited so output goes directly to terminal
		const exitCode = yield* Effect.tryPromise({
			try: async () => {
				const proc = Bun.spawn(ghArgs, {
					cwd: gitRoot,
					env: process.env,
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

Wrapper for 'gh pr' that automatically uses the emitted branch in agency context.

For gh pr subcommands that accept a PR selector, this command appends the
emitted branch name when you do not provide a selector. Outside agency context,
or when you provide a selector, it passes arguments through to 'gh pr' unchanged.

Examples:
  agency pr view --web              # gh pr view --web <emit-branch>
  agency pr checks                  # gh pr checks <emit-branch>
  agency pr diff                    # gh pr diff <emit-branch>

Notes:
  - Requires gh CLI to be installed and authenticated
  - Uses source and emit patterns from ~/.config/agency/agency.json
  - Respects emitBranch field in agency.json when present
  - Falls through to gh pr unchanged outside agency context
`
