import { Effect } from "effect"
import type { BaseCommandOptions } from "../utils/command"
import { GitService } from "../services/GitService"
import { FileSystemService } from "../services/FileSystemService"
import { AgencyMetadataService } from "../services/AgencyMetadataService"
import highlight, { done, info } from "../utils/colors"
import {
	createLoggers,
	ensureGitRepo,
	resolveBaseBranch,
	withBranchProtection,
} from "../utils/effect"
import { withSpinner } from "../utils/spinner"

interface RebaseOptions extends BaseCommandOptions {
	baseBranch?: string // Internal option, populated from positional arg
	emit?: string // Custom emit branch name to set after rebase
	branch?: string // Deprecated: use emit instead
}

export const rebase = (options: RebaseOptions = {}) =>
	Effect.gen(function* () {
		const gitRoot = yield* ensureGitRepo()

		// Wrap the entire rebase operation with branch protection
		yield* withBranchProtection(gitRoot, rebaseCore(gitRoot, options))
	})

const rebaseCore = (gitRoot: string, options: RebaseOptions) =>
	Effect.gen(function* () {
		const { verbose = false } = options
		const { log, verboseLog } = createLoggers(options)

		const git = yield* GitService

		// Get current branch
		const currentBranch = yield* git.getCurrentBranch(gitRoot)
		verboseLog(`Current branch: ${highlight.branch(currentBranch)}`)

		// Check if current branch has agency.json (is a source branch)
		const metadataService = yield* Effect.gen(function* () {
			return yield* AgencyMetadataService
		}).pipe(Effect.provide(AgencyMetadataService.Default))

		const metadata = yield* metadataService.readFromDisk(gitRoot)

		if (!metadata) {
			return yield* Effect.fail(
				new Error(
					`Current branch ${highlight.branch(currentBranch)} does not have agency.json.\n` +
						`The rebase command can only be used on agency source branches.\n` +
						`Run 'agency task' first to initialize this branch, or switch to an existing agency branch.`,
				),
			)
		}

		verboseLog(`Branch is an agency source branch`)

		// Check for uncommitted changes
		const statusOutput = yield* git.getStatus(gitRoot)

		if (statusOutput && statusOutput.trim().length > 0) {
			return yield* Effect.fail(
				new Error(
					`You have uncommitted changes. Please commit or stash them before rebasing.\n` +
						`Run 'git status' to see the changes.`,
				),
			)
		}

		verboseLog(`Working directory is clean`)

		// Resolve base branch (what we're rebasing onto)
		const baseBranch = yield* resolveBaseBranch(gitRoot, options.baseBranch)
		verboseLog(`Base branch: ${highlight.branch(baseBranch)}`)

		// Check if base branch is a remote branch
		const hasRemotePrefix = yield* git.hasRemotePrefix(baseBranch, gitRoot)

		if (hasRemotePrefix) {
			// Extract remote name from branch (e.g., "origin/main" -> "origin")
			const remote = yield* git.getRemoteFromBranch(baseBranch, gitRoot)

			if (remote) {
				// Fetch the remote to ensure we have the latest commits
				const fetchOperation = Effect.gen(function* () {
					verboseLog(`Fetching ${highlight.branch(remote)}`)
					yield* git.fetch(gitRoot, remote)
					verboseLog(`Fetched ${highlight.branch(remote)}`)
				})

				yield* withSpinner(fetchOperation, {
					text: `Fetching ${highlight.branch(remote)}`,
					successText: `Fetched ${highlight.branch(remote)}`,
					enabled: !options.silent && !verbose,
				})
			}
		}

		// Perform the rebase
		log(
			info(
				`Rebasing ${highlight.branch(currentBranch)} onto ${highlight.branch(baseBranch)}`,
			),
		)

		const rebaseOperation = Effect.gen(function* () {
			verboseLog(`Running: git rebase ${baseBranch}`)

			const result = yield* git.rebase(gitRoot, baseBranch)

			if (result.exitCode !== 0) {
				return yield* Effect.fail(
					new Error(
						`Rebase failed with conflicts.\n\n` +
							`${result.stderr}\n\n` +
							`To resolve:\n` +
							`  1. Fix the conflicts in your files\n` +
							`  2. Run: git add <resolved-files>\n` +
							`  3. Run: git rebase --continue\n\n` +
							`To abort the rebase:\n` +
							`  Run: git rebase --abort`,
					),
				)
			}

			verboseLog(`Rebase completed successfully`)
		})

		yield* withSpinner(rebaseOperation, {
			text: "Rebasing branch",
			successText: "Rebased branch successfully",
			enabled: !options.silent && !verbose,
		})

		log(
			done(
				`Rebased ${highlight.branch(currentBranch)} onto ${highlight.branch(baseBranch)}`,
			),
		)

		// Update emit branch in agency.json if --emit/--branch flag was provided
		const newEmitBranch = options.emit || options.branch
		if (newEmitBranch && metadata) {
			verboseLog(`Updating emit branch to: ${highlight.branch(newEmitBranch)}`)

			// Update metadata with new emit branch
			const updatedMetadata = {
				...metadata,
				emitBranch: newEmitBranch,
			}

			yield* Effect.tryPromise({
				try: async () => {
					const { writeAgencyMetadata } = await import("../types")
					await writeAgencyMetadata(gitRoot, updatedMetadata)
				},
				catch: (error) => new Error(`Failed to update agency.json: ${error}`),
			})

			// Stage and commit the change
			yield* git.gitAdd(["agency.json"], gitRoot)
			// Format: chore: agency rebase (baseBranch) sourceBranch → emitBranch
			const commitMessage = `chore: agency rebase (${baseBranch}) ${currentBranch} → ${newEmitBranch}`
			yield* git.gitCommit(commitMessage, gitRoot, { noVerify: true })

			log(info(`Updated emit branch to ${highlight.branch(newEmitBranch)}`))
		}

		// Inform user about next steps
		log(
			info(
				`Your source branch has been rebased. You may want to:\n` +
					`  - Run 'agency emit' to regenerate your emit branch\n` +
					`  - Run 'agency push --force' to update the remote branch (use with caution)`,
			),
		)
	})

export const help = `
Usage: agency rebase [options]

Rebase the current agency source branch onto the latest base branch (typically origin/main).

This command is useful when:
  - Your work has been merged to the main branch via PR
  - You want to continue working on the same branch with a clean history
  - You want to incorporate the latest changes from main into your branch

Behavior:
  - Ensures you're on an agency source branch (has agency.json)
  - Checks for uncommitted changes (rebase requires a clean working directory)
  - Fetches the latest from the base branch if it's a remote branch
  - Rebases your current branch onto the base branch
  - All agency files (TASK.md, AGENTS.md, opencode.json, etc.) are preserved
  - Your emit branch may need to be regenerated with 'agency emit'

Base Branch Selection:
  The command determines the base branch in this order:
  1. Explicitly provided base-branch argument
  2. Branch-specific base branch from agency.json (set by 'agency task')
  3. Repository-level default base branch from .git/config
  4. Auto-detected from origin/HEAD or common branches (origin/main, etc.)

Arguments:
  [base-branch]             Optional base branch to rebase onto
                            (defaults to saved base branch or origin/main)

Options:
  --emit <name>             Set a new emit branch name in agency.json after rebasing
  --branch <name>           (Deprecated: use --emit) Set a new emit branch name

Examples:
  agency rebase                    # Rebase onto saved base branch
  agency rebase origin/main        # Rebase onto origin/main explicitly
  agency rebase --emit new-branch  # Rebase and set new emit branch name

Workflow:
  1. User works on agency--feature-A branch
  2. User runs 'agency emit' and 'agency push' to create a PR
  3. PR gets merged into main
  4. User runs 'agency rebase' to rebase agency--feature-A onto origin/main
  5. User continues working on agency--feature-A with updated main branch
  6. User runs 'agency emit' again to create a fresh emit branch

Notes:
  - This command only works on agency source branches (with agency.json)
  - If conflicts occur during rebase, you must resolve them manually
  - After rebasing, your emit branch will be outdated - run 'agency emit' to regenerate it
  - Be careful when force-pushing after a rebase - coordinate with your team
  - This command is different from 'agency task --continue' which creates a new branch
`
