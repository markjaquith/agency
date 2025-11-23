import { Effect } from "effect"
import { GitService, GitCommandError } from "../services/GitService"
import { ConfigService } from "../services/ConfigService"
import { extractSourceBranch, makePrBranchName } from "../utils/pr-branch"
import { getBaseBranchFromMetadata } from "../types"
import { pr } from "./pr"
import highlight, { done } from "../utils/colors"
import { runEffect, createLoggers, ensureGitRepo } from "../utils/effect"

export interface MergeOptions {
	silent?: boolean
	verbose?: boolean
	squash?: boolean
}

// Helper to merge a branch using git
const mergeBranchEffect = (
	gitRoot: string,
	branch: string,
	squash: boolean = false,
) =>
	Effect.gen(function* () {
		const args = ["git", "merge"]
		if (squash) {
			args.push("--squash")
		}
		args.push(branch)

		const proc = Bun.spawn(args, {
			cwd: gitRoot,
			stdout: "pipe",
			stderr: "pipe",
		})

		yield* Effect.promise(() => proc.exited)

		if (proc.exitCode !== 0) {
			const stderr = yield* Effect.promise(() =>
				new Response(proc.stderr).text(),
			)
			return yield* Effect.fail(
				new GitCommandError({
					command: args.join(" "),
					exitCode: proc.exitCode || 1,
					stderr,
				}),
			)
		}
	})

// Effect-based implementation
export const mergeEffect = (options: MergeOptions = {}) =>
	Effect.gen(function* () {
		const { squash = false, verbose = false } = options
		const { log, verboseLog } = createLoggers(options)

		const git = yield* GitService
		const configService = yield* ConfigService

		const gitRoot = yield* ensureGitRepo()

		const config = yield* configService.loadConfig()
		const currentBranch = yield* git.getCurrentBranch(gitRoot)

		verboseLog(`Current branch: ${highlight.branch(currentBranch)}`)

		const sourceBranch = extractSourceBranch(currentBranch, config.prBranch)

		let prBranchToMerge: string
		let baseBranchToMergeInto: string

		if (sourceBranch) {
			verboseLog(
				`Current branch appears to be a PR branch for source: ${highlight.branch(sourceBranch)}`,
			)

			const sourceExists = yield* git.branchExists(gitRoot, sourceBranch)
			if (!sourceExists) {
				return yield* Effect.fail(
					new Error(
						`Current branch ${highlight.branch(currentBranch)} appears to be a PR branch, but source branch ${highlight.branch(sourceBranch)} does not exist.\n` +
							`Cannot merge without a valid source branch.`,
					),
				)
			}

			// Get the base branch from the source branch's agency.json
			// We need to temporarily switch to the source branch to read its agency.json
			yield* git.checkoutBranch(gitRoot, sourceBranch)
			const configuredBase = yield* Effect.promise(() =>
				getBaseBranchFromMetadata(gitRoot),
			)
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
			const baseExists = yield* git.branchExists(gitRoot, baseBranchToMergeInto)
			if (!baseExists) {
				return yield* Effect.fail(
					new Error(
						`Base branch ${highlight.branch(baseBranchToMergeInto)} does not exist locally.\n` +
							`You may need to checkout the branch first or update your base branch configuration.`,
					),
				)
			}

			prBranchToMerge = currentBranch
		} else {
			// We're on a source branch - need to create/update PR branch first
			verboseLog(
				`Current branch appears to be a source branch, will create PR branch first`,
			)

			// Check if a corresponding PR branch already exists
			const prBranch = makePrBranchName(currentBranch, config.prBranch)
			const prExists = yield* git.branchExists(gitRoot, prBranch)

			if (prExists) {
				verboseLog(
					`PR branch ${highlight.branch(prBranch)} already exists, will recreate it`,
				)
			}

			// Run 'agency pr' to create/update the PR branch
			verboseLog(`Creating PR branch ${highlight.branch(prBranch)}...`)
			yield* Effect.promise(() => pr({ silent: true, verbose }))

			// Switch back to source branch and get the base branch from agency.json
			yield* git.checkoutBranch(gitRoot, currentBranch)
			const configuredBase = yield* Effect.promise(() =>
				getBaseBranchFromMetadata(gitRoot),
			)
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
			const baseExists = yield* git.branchExists(gitRoot, baseBranchToMergeInto)
			if (!baseExists) {
				return yield* Effect.fail(
					new Error(
						`Base branch ${highlight.branch(baseBranchToMergeInto)} does not exist locally.\n` +
							`You may need to checkout the branch first or update your base branch configuration.`,
					),
				)
			}

			prBranchToMerge = prBranch
		}

		// Now switch to the base branch
		verboseLog(`Switching to ${highlight.branch(baseBranchToMergeInto)}...`)
		yield* git.checkoutBranch(gitRoot, baseBranchToMergeInto)

		// Merge the PR branch
		verboseLog(
			`Merging ${highlight.branch(prBranchToMerge)} into ${highlight.branch(baseBranchToMergeInto)}${squash ? " (squash)" : ""}...`,
		)
		yield* mergeBranchEffect(gitRoot, prBranchToMerge, squash)

		if (squash) {
			log(
				done(
					`Squash merged ${highlight.branch(prBranchToMerge)} into ${highlight.branch(baseBranchToMergeInto)} (staged, not committed)`,
				),
			)
		} else {
			log(
				done(
					`Merged ${highlight.branch(prBranchToMerge)} into ${highlight.branch(baseBranchToMergeInto)}`,
				),
			)
		}
	})

// Backward-compatible Promise wrapper
export async function merge(options: MergeOptions = {}): Promise<void> {
	const { GitServiceLive } = await import("../services/GitServiceLive")
	const { ConfigServiceLive } = await import("../services/ConfigServiceLive")

	await runEffect(mergeEffect(options), [GitServiceLive, ConfigServiceLive])
}

export const help = `
Usage: agency merge [options]

Merge the current PR branch into the configured base branch.

This command handles two scenarios:
  1. If on a PR branch (e.g., feature--PR): Switches to the base branch and merges the PR branch
  2. If on a source branch (e.g., feature): Runs 'agency pr' first to create/update the PR branch, then merges it

Behavior:
  - Automatically detects whether you're on a source or PR branch
  - Retrieves the configured base branch (e.g., 'main') from git config
  - Switches to the base branch
  - Merges the PR branch into the base branch
  - Leaves you on the base branch after merge

This is useful for local development workflows where you want to test merging
your clean PR branch (without AGENTS.md modifications) into the base branch
before pushing.

Prerequisites:
  - Must be on either a source branch or its corresponding PR branch
  - Base branch must exist locally
  - For source branches: Must have a corresponding PR branch or be able to create one

Options:
  --squash                       # Use squash merge instead of regular merge

Examples:
  agency merge                   # From source branch: creates PR branch then merges
  agency merge --squash          # Squash merge (stages changes, requires manual commit)

Notes:
  - The command determines the base branch from git config (agency.pr.<branch>.baseBranch)
  - If you're on a source branch, 'agency pr' is run automatically
  - The PR branch must have both a source branch and base branch configured
  - After merge, you remain on the base branch
  - Merge conflicts must be resolved manually if they occur
  - With --squash, changes are staged but not committed (you must commit manually)
`
