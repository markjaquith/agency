import { Effect } from "effect"
import type { BaseCommandOptions } from "../utils/command"
import { GitService, GitCommandError } from "../services/GitService"
import { ConfigService } from "../services/ConfigService"
import { extractSourceBranch, makePrBranchName } from "../utils/pr-branch"
import { emit } from "./emit"
import highlight, { done } from "../utils/colors"
import {
	createLoggers,
	ensureGitRepo,
	ensureBranchExists,
	getBaseBranchFromMetadataEffect,
	getRemoteName,
} from "../utils/effect"

interface MergeOptions extends BaseCommandOptions {
	squash?: boolean
	push?: boolean
}

// Helper to merge a branch using git
const mergeBranchEffect = (
	gitRoot: string,
	branch: string,
	squash: boolean = false,
) =>
	Effect.gen(function* () {
		const git = yield* GitService
		const args = squash
			? ["git", "merge", "--squash", branch]
			: ["git", "merge", branch]

		const result = yield* git.runGitCommand(args, gitRoot, {
			captureOutput: true,
		})

		if (result.exitCode !== 0) {
			return yield* Effect.fail(
				new GitCommandError({
					command: args.join(" "),
					exitCode: result.exitCode,
					stderr: result.stderr,
				}),
			)
		}
	})

export const merge = (options: MergeOptions = {}) =>
	Effect.gen(function* () {
		const { squash = false, push = false, verbose = false } = options
		const { log, verboseLog } = createLoggers(options)

		const git = yield* GitService
		const configService = yield* ConfigService

		const gitRoot = yield* ensureGitRepo()

		const config = yield* configService.loadConfig()
		const currentBranch = yield* git.getCurrentBranch(gitRoot)

		verboseLog(`Current branch: ${highlight.branch(currentBranch)}`)

		const sourceBranch = extractSourceBranch(currentBranch, config.emitBranch)

		let emitBranchToMerge: string
		let baseBranchToMergeInto: string

		if (sourceBranch) {
			verboseLog(
				`Current branch appears to be an emit branch for source: ${highlight.branch(sourceBranch)}`,
			)

			yield* ensureBranchExists(
				gitRoot,
				sourceBranch,
				`Current branch ${highlight.branch(currentBranch)} appears to be an emit branch, but source branch ${highlight.branch(sourceBranch)} does not exist.\n` +
					`Cannot merge without a valid source branch.`,
			)

			// Get the base branch from the source branch's agency.json
			// We need to temporarily switch to the source branch to read its agency.json
			yield* git.checkoutBranch(gitRoot, sourceBranch)
			const configuredBase = yield* getBaseBranchFromMetadataEffect(gitRoot)
			yield* git.checkoutBranch(gitRoot, currentBranch)

			if (!configuredBase) {
				return yield* Effect.fail(
					new Error(
						`No base branch configured for ${highlight.branch(sourceBranch)}.\n` +
							`Please switch to ${highlight.branch(sourceBranch)} and run: agency base set <branch>`,
					),
				)
			}

			verboseLog(`Configured base branch: ${highlight.branch(configuredBase)}`)

			// For git operations (checkout/merge), use local branch name
			baseBranchToMergeInto = configuredBase.replace(/^origin\//, "")

			// Verify local base branch exists
			yield* ensureBranchExists(
				gitRoot,
				baseBranchToMergeInto,
				`Base branch ${highlight.branch(baseBranchToMergeInto)} does not exist locally.\n` +
					`You may need to checkout the branch first or update your base branch configuration.`,
			)

			emitBranchToMerge = currentBranch
		} else {
			// We're on a source branch - need to create/update emit branch first
			verboseLog(
				`Current branch appears to be a source branch, will create emit branch first`,
			)

			// Check if a corresponding emit branch already exists
			const emitBranch = makePrBranchName(currentBranch, config.emitBranch)
			const emitExists = yield* git.branchExists(gitRoot, emitBranch)

			if (emitExists) {
				verboseLog(
					`Emit branch ${highlight.branch(emitBranch)} already exists, will recreate it`,
				)
			}

			// Run 'agency emit' to create/update the emit branch
			verboseLog(`Creating emit branch ${highlight.branch(emitBranch)}...`)
			yield* emit({ silent: true, verbose })

			// Switch back to source branch and get the base branch from agency.json
			yield* git.checkoutBranch(gitRoot, currentBranch)
			const configuredBase = yield* getBaseBranchFromMetadataEffect(gitRoot)
			if (!configuredBase) {
				return yield* Effect.fail(
					new Error(
						`No base branch configured for ${highlight.branch(currentBranch)}.\n` +
							`Please set one with: agency base set <branch>`,
					),
				)
			}

			verboseLog(`Configured base branch: ${highlight.branch(configuredBase)}`)

			// For git operations (checkout/merge), use local branch name
			baseBranchToMergeInto = configuredBase.replace(/^origin\//, "")

			// Verify local base branch exists
			yield* ensureBranchExists(
				gitRoot,
				baseBranchToMergeInto,
				`Base branch ${highlight.branch(baseBranchToMergeInto)} does not exist locally.\n` +
					`You may need to checkout the branch first or update your base branch configuration.`,
			)

			emitBranchToMerge = emitBranch
		}

		// Now switch to the base branch
		verboseLog(`Switching to ${highlight.branch(baseBranchToMergeInto)}...`)
		yield* git.checkoutBranch(gitRoot, baseBranchToMergeInto)

		// Merge the emit branch
		verboseLog(
			`Merging ${highlight.branch(emitBranchToMerge)} into ${highlight.branch(baseBranchToMergeInto)}${squash ? " (squash)" : ""}...`,
		)
		yield* mergeBranchEffect(gitRoot, emitBranchToMerge, squash)

		if (squash) {
			log(done(`Squash merged (awaiting commit)`))
		} else {
			log(done("Merged"))
		}

		// Push the base branch if --push flag is set
		if (push) {
			const remote = yield* getRemoteName(gitRoot)
			verboseLog(
				`Pushing ${highlight.branch(baseBranchToMergeInto)} to ${remote}...`,
			)

			const pushResult = yield* git.runGitCommand(
				["git", "push", remote, baseBranchToMergeInto],
				gitRoot,
				{ captureOutput: true },
			)

			if (pushResult.exitCode !== 0) {
				return yield* Effect.fail(
					new GitCommandError({
						command: `git push ${remote} ${baseBranchToMergeInto}`,
						exitCode: pushResult.exitCode,
						stderr: pushResult.stderr,
					}),
				)
			}

			log(done(`Pushed to ${remote}`))
		}
	})

export const help = `
Usage: agency merge [options]

Merge the current emit branch into the configured base branch.

This command handles two scenarios:
  1. If on an emit branch (e.g., feature--PR): Switches to the base branch and merges the emit branch
  2. If on a source branch (e.g., feature): Runs 'agency emit' first to create/update the emit branch, then merges it

Behavior:
  - Automatically detects whether you're on a source or emit branch
  - Retrieves the configured base branch (e.g., 'main') from git config
  - Switches to the base branch
  - Merges the emit branch into the base branch
  - Leaves you on the base branch after merge

This is useful for local development workflows where you want to test merging
your clean emit branch (without AGENTS.md modifications) into the base branch
before pushing.

Prerequisites:
  - Must be on either a source branch or its corresponding emit branch
  - Base branch must exist locally
  - For source branches: Must have a corresponding emit branch or be able to create one

Options:
  --squash                       # Use squash merge instead of regular merge
  --push                         # Push the base branch to origin after merging

Examples:
  agency merge                   # From source branch: creates emit branch then merges
  agency merge --squash          # Squash merge (stages changes, requires manual commit)
  agency merge --push            # Merge and push the base branch to origin

Notes:
  - The command determines the base branch from git config (agency.pr.<branch>.baseBranch)
  - If you're on a source branch, 'agency emit' is run automatically
  - The emit branch must have both a source branch and base branch configured
  - After merge, you remain on the base branch
  - Merge conflicts must be resolved manually if they occur
  - With --squash, changes are staged but not committed (you must commit manually)
  - With --push, the base branch is pushed to origin after a successful merge
`
