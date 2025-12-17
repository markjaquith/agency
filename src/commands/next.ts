import { Effect } from "effect"
import type { BaseCommandOptions } from "../utils/command"
import { GitService } from "../services/GitService"
import { FileSystemService } from "../services/FileSystemService"
import {
	AgencyMetadataService,
	AgencyMetadataServiceLive,
} from "../services/AgencyMetadataService"
import highlight, { done, info } from "../utils/colors"
import {
	createLoggers,
	ensureGitRepo,
	resolveBaseBranch,
	withBranchProtection,
} from "../utils/effect"
import { withSpinner } from "../utils/spinner"

interface NextOptions extends BaseCommandOptions {
	baseBranch?: string
}

export const next = (options: NextOptions = {}) =>
	Effect.gen(function* () {
		const gitRoot = yield* ensureGitRepo()

		// Wrap the entire next operation with branch protection
		yield* withBranchProtection(gitRoot, nextCore(gitRoot, options))
	})

const nextCore = (gitRoot: string, options: NextOptions) =>
	Effect.gen(function* () {
		const { verbose = false } = options
		const { log, verboseLog } = createLoggers(options)

		const git = yield* GitService
		const fs = yield* FileSystemService

		// Check if git-filter-repo is installed
		const hasFilterRepo = yield* git.checkCommandExists("git-filter-repo")
		if (!hasFilterRepo) {
			const isMac = process.platform === "darwin"
			const installInstructions = isMac
				? "Please install it via Homebrew: brew install git-filter-repo"
				: "Please install it using your package manager. See: https://github.com/newren/git-filter-repo/blob/main/INSTALL.md"
			return yield* Effect.fail(
				new Error(`git-filter-repo is not installed. ${installInstructions}`),
			)
		}

		// Get current branch
		const currentBranch = yield* git.getCurrentBranch(gitRoot)
		verboseLog(`Current branch: ${highlight.branch(currentBranch)}`)

		// Check if current branch has agency.json (is a source branch)
		const metadataService = yield* Effect.gen(function* () {
			return yield* AgencyMetadataService
		}).pipe(Effect.provide(AgencyMetadataServiceLive))

		const metadata = yield* metadataService.readFromDisk(gitRoot)

		if (!metadata) {
			return yield* Effect.fail(
				new Error(
					`Current branch ${highlight.branch(currentBranch)} does not have agency.json.\n` +
						`The next command can only be used on agency source branches.\n` +
						`Run 'agency task' first to initialize this branch, or switch to an existing agency branch.`,
				),
			)
		}

		verboseLog(`Branch is an agency source branch`)

		// Check for uncommitted changes
		const statusResult = yield* git.runGitCommand(
			["git", "status", "--porcelain"],
			gitRoot,
			{ captureOutput: true },
		)

		if (statusResult.stdout && statusResult.stdout.trim().length > 0) {
			return yield* Effect.fail(
				new Error(
					`You have uncommitted changes. Please commit or stash them before running next.\n` +
						`Run 'git status' to see the changes.`,
				),
			)
		}

		verboseLog(`Working directory is clean`)

		// Resolve base branch (what we're rebasing onto)
		const baseBranch = yield* resolveBaseBranch(gitRoot, options.baseBranch)
		verboseLog(`Base branch: ${highlight.branch(baseBranch)}`)

		// Check if base branch is a remote branch and fetch if needed
		const hasRemotePrefix = yield* git.hasRemotePrefix(baseBranch, gitRoot)

		if (hasRemotePrefix) {
			const remote = yield* git.getRemoteFromBranch(baseBranch, gitRoot)

			if (remote) {
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

		// Get the fork-point
		const forkPoint = yield* getForkPointOrMergeBase(
			git,
			gitRoot,
			baseBranch,
			currentBranch,
		)
		verboseLog(`Fork point: ${highlight.commit(forkPoint.substring(0, 8))}`)

		// Get files to KEEP (agency files)
		const filesToKeep = yield* metadataService.getFilesToFilter(gitRoot)
		verboseLog(`Files to keep: ${filesToKeep.join(", ")}`)

		// Filter to keep only agency files
		log(
			info(
				`Filtering ${highlight.branch(currentBranch)} to keep only agency files`,
			),
		)

		const filterOperation = Effect.gen(function* () {
			// Clean up .git/filter-repo directory
			const filterRepoDir = `${gitRoot}/.git/filter-repo`
			yield* fs.deleteDirectory(filterRepoDir)
			verboseLog("Cleaned up previous git-filter-repo state")

			// Run git-filter-repo to KEEP only agency files (no --invert-paths)
			const filterRepoArgs = [
				"git",
				"filter-repo",
				...filesToKeep.flatMap((f) => ["--path", f]),
				"--force",
				"--refs",
				`${forkPoint}..HEAD`,
			]

			verboseLog(`Running: ${filterRepoArgs.join(" ")}`)

			const result = yield* git.runGitCommand(filterRepoArgs, gitRoot, {
				env: { GIT_CONFIG_GLOBAL: "" },
				captureOutput: true,
			})

			if (result.exitCode !== 0) {
				return yield* Effect.fail(
					new Error(`git-filter-repo failed: ${result.stderr}`),
				)
			}

			verboseLog("git-filter-repo completed")
		})

		yield* withSpinner(filterOperation, {
			text: "Filtering branch to keep only agency files",
			successText: "Filtered branch to keep only agency files",
			enabled: !options.silent && !verbose,
		})

		// Rebase onto base branch
		log(
			info(
				`Rebasing ${highlight.branch(currentBranch)} onto ${highlight.branch(baseBranch)}`,
			),
		)

		const rebaseOperation = Effect.gen(function* () {
			verboseLog(`Running: git rebase ${baseBranch}`)

			const result = yield* git.runGitCommand(
				["git", "rebase", baseBranch],
				gitRoot,
				{ captureOutput: true },
			)

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
				`Completed next for ${highlight.branch(currentBranch)} onto ${highlight.branch(baseBranch)}`,
			),
		)

		// Inform user about next steps
		log(
			info(
				`Your source branch now contains only agency files, rebased on ${highlight.branch(baseBranch)}.\n` +
					`You can continue working on your task. When ready:\n` +
					`  - Run 'agency emit' to create a new emit branch\n` +
					`  - Run 'agency push' to push and create a PR`,
			),
		)
	})

/**
 * Get the fork point for a branch against a reference.
 * Falls back to merge-base if fork-point command fails.
 */
const getForkPointOrMergeBase = (
	git: GitService,
	gitRoot: string,
	referenceBranch: string,
	featureBranch: string,
) =>
	git.getMergeBaseForkPoint(gitRoot, referenceBranch, featureBranch).pipe(
		Effect.catchAll(() =>
			// Fork-point can fail if the reflog doesn't have enough history
			git.getMergeBase(gitRoot, featureBranch, referenceBranch),
		),
	)

export const help = `
Usage: agency next [base-branch] [options]

After a PR is merged, continue working on the same task by filtering the source
branch to keep only agency files and rebasing onto the updated base branch.

This command is useful when:
  - Your work has been merged to main via PR
  - You want to continue working on the same task (multi-phase work)
  - You want to preserve the agency context (TASK.md, etc.) while discarding
    the work commits (which are now in main)

Behavior:
  - Ensures you're on an agency source branch (has agency.json)
  - Checks for uncommitted changes
  - Fetches the latest from the base branch if it's a remote branch
  - Filters the branch to keep ONLY agency files (TASK.md, AGENTS.md, etc.)
  - Rebases the filtered branch onto the base branch
  - Work commits are discarded (they're already in main via merged PR)

Base Branch Selection:
  The command determines the base branch in this order:
  1. Explicitly provided base-branch argument
  2. Branch-specific base branch from agency.json (set by 'agency task')
  3. Repository-level default base branch from .git/config
  4. Auto-detected from origin/HEAD or common branches (origin/main, etc.)

Arguments:
  [base-branch]             Optional base branch to rebase onto
                            (defaults to saved base branch or origin/main)

Examples:
  agency next                        # Filter and rebase onto saved base branch
  agency next origin/main            # Filter and rebase onto origin/main explicitly

Workflow:
  1. User works on agency/feature-A branch (phase 1)
  2. User runs 'agency emit' and 'agency push' to create a PR
  3. PR gets reviewed and merged into main
  4. User runs 'agency next' to:
     - Filter out work commits (now in main)
     - Keep agency context (TASK.md, etc.)
     - Rebase onto updated origin/main
  5. User continues working on phase 2 of the task
  6. Repeat from step 2

Notes:
  - This command only works on agency source branches (with agency.json)
  - Requires git-filter-repo to be installed
  - If conflicts occur during rebase, you must resolve them manually
  - Work commits are permanently removed from the branch (they're in main)
  - Agency file commits are preserved and rebased
`
