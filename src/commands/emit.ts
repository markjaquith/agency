import { Effect } from "effect"
import type { BaseCommandOptions } from "../utils/command"
import { GitService } from "../services/GitService"
import { ConfigService } from "../services/ConfigService"
import { FileSystemService } from "../services/FileSystemService"
import { FilterRepoService } from "../services/FilterRepoService"
import {
	makeEmitBranchName,
	makeSourceBranchName,
	extractCleanBranch,
	extractCleanFromEmit,
} from "../utils/pr-branch"
import {
	getFilesToFilter,
	readAgencyMetadata,
	writeAgencyMetadata,
} from "../types"
import highlight, { done } from "../utils/colors"
import {
	createLoggers,
	ensureGitRepo,
	resolveBaseBranch,
	withBranchProtection,
} from "../utils/effect"
import { withSpinner } from "../utils/spinner"
import { AGENCY_REMOVE_COMMIT } from "../constants"

interface EmitOptions extends BaseCommandOptions {
	emit?: string
	branch?: string // Deprecated: use emit instead
	baseBranch?: string
	force?: boolean
	/** Skip the git-filter-repo step (for testing) */
	skipFilter?: boolean
}

export const emit = (options: EmitOptions = {}) =>
	Effect.gen(function* () {
		const gitRoot = yield* ensureGitRepo()

		// Wrap the entire emit operation with branch protection
		// This ensures we return to the original branch on Ctrl-C interrupt
		yield* withBranchProtection(gitRoot, emitCore(gitRoot, options))
	})

export const emitCore = (gitRoot: string, options: EmitOptions) =>
	Effect.gen(function* () {
		const { force = false, verbose = false, skipFilter = false } = options
		const { log, verboseLog } = createLoggers(options)

		const git = yield* GitService
		const configService = yield* ConfigService
		const fs = yield* FileSystemService
		const filterRepo = yield* FilterRepoService

		// Check if git-filter-repo is installed
		const hasFilterRepo = yield* filterRepo.isInstalled()
		if (!hasFilterRepo) {
			const isMac = process.platform === "darwin"
			const installInstructions = isMac
				? "Please install it via Homebrew: brew install git-filter-repo"
				: "Please install it using your package manager. See: https://github.com/newren/git-filter-repo/blob/main/INSTALL.md"
			return yield* Effect.fail(
				new Error(`git-filter-repo is not installed. ${installInstructions}`),
			)
		}

		// Load config
		const config = yield* configService.loadConfig()

		// Get current branch
		let currentBranch = yield* git.getCurrentBranch(gitRoot)

		// Check if current branch is an emit branch (doesn't match source pattern)
		// If so, try to find and switch to the corresponding source branch
		const possibleCleanBranch = extractCleanFromEmit(
			currentBranch,
			config.emitBranch,
		)
		if (possibleCleanBranch) {
			// This looks like an emit branch, try to find the source branch
			const possibleSourceBranch = makeSourceBranchName(
				possibleCleanBranch,
				config.sourceBranchPattern,
			)
			const sourceExists = yield* git.branchExists(
				gitRoot,
				possibleSourceBranch,
			)
			if (sourceExists) {
				// Switch to the source branch and continue
				verboseLog(
					`Currently on emit branch ${highlight.branch(currentBranch)}, switching to source branch ${highlight.branch(possibleSourceBranch)}`,
				)
				yield* git.checkoutBranch(gitRoot, possibleSourceBranch)
				currentBranch = possibleSourceBranch
			}
		}

		// First, check if agency.json already has emitBranch set (source of truth)
		const metadata = yield* Effect.tryPromise({
			try: () => readAgencyMetadata(gitRoot),
			catch: () => null,
		})

		let emitBranchName: string

		// Support both --emit (new) and --branch (deprecated)
		const explicitBranchName = options.emit || options.branch

		if (explicitBranchName) {
			// Explicit branch name provided via CLI
			emitBranchName = explicitBranchName
		} else if (metadata?.emitBranch) {
			// Use emitBranch from agency.json (source of truth)
			emitBranchName = metadata.emitBranch
			verboseLog(
				`Using emit branch from agency.json: ${highlight.branch(emitBranchName)}`,
			)
		} else {
			// Compute emit branch name from patterns
			// Extract clean branch from source branch pattern
			// If the branch matches the source pattern, extract the clean name
			// Otherwise, treat the current branch as a "legacy" branch (the clean name itself)
			const cleanBranch =
				extractCleanBranch(currentBranch, config.sourceBranchPattern) ||
				currentBranch
			emitBranchName = makeEmitBranchName(cleanBranch, config.emitBranch)
		}

		// Check and update agency.json with emitBranch if needed
		yield* ensureEmitBranchInMetadata(gitRoot, currentBranch, emitBranchName)

		// Find the base branch this was created from
		const baseBranch = yield* resolveBaseBranch(gitRoot, options.baseBranch)

		verboseLog(`Using base branch: ${highlight.branch(baseBranch)}`)

		// Get the fork-point (where the branch actually forked from, using reflog)
		// This is more accurate than merge-base because it accounts for rebases
		const forkPoint = yield* findBestForkPoint(
			gitRoot,
			currentBranch,
			baseBranch,
			verbose,
		)

		verboseLog(`Branch forked at commit: ${highlight.commit(forkPoint)}`)

		// Create or reset emit branch from current branch
		let branchExisted = false
		const createBranch = Effect.gen(function* () {
			const existed = yield* createOrResetBranchEffect(
				gitRoot,
				currentBranch,
				emitBranchName,
			)
			branchExisted = existed

			// Unset any remote tracking branch for the emit branch
			yield* git.unsetGitConfig(`branch.${emitBranchName}.remote`, gitRoot)
			yield* git.unsetGitConfig(`branch.${emitBranchName}.merge`, gitRoot)
		})

		yield* withSpinner(createBranch, {
			text: `Creating emit branch ${highlight.branch(emitBranchName)}`,
			successText: `${branchExisted ? "Recreated" : "Created"} emit branch ${highlight.branch(emitBranchName)}`,
			enabled: !options.silent && !verbose,
		})

		// Skip filtering if requested (for testing)
		if (skipFilter) {
			verboseLog("Skipping git-filter-repo (skipFilter=true)")
			// Just switch back to source branch
			yield* git.checkoutBranch(gitRoot, currentBranch)
			log(done(`Emitted ${highlight.branch(emitBranchName)} (filter skipped)`))
			return
		}

		verboseLog(
			`Filtering backpack files from commits in range: ${highlight.commit(forkPoint.substring(0, 8))}..${highlight.branch(emitBranchName)}`,
		)
		verboseLog(
			`Files will revert to their state at fork-point (base branch: ${highlight.branch(baseBranch)})`,
		)

		// Filter backpack files
		const filterOperation = Effect.gen(function* () {
			// Clean up .git/filter-repo directory
			const filterRepoDir = `${gitRoot}/.git/filter-repo`
			yield* fs.deleteDirectory(filterRepoDir)
			verboseLog("Cleaned up previous git-filter-repo state")

			// Get files to filter from agency.json metadata
			const filesToFilter = yield* Effect.tryPromise({
				try: () => getFilesToFilter(gitRoot),
				catch: (error) => new Error(`Failed to get files to filter: ${error}`),
			})
			verboseLog(`Files to filter: ${filesToFilter.join(", ")}`)

			// Run git-filter-repo with:
			// 1. Path filtering to remove backpack files
			// 2. Commit callback to drop file changes from commits marked with AGENCY_REMOVE_COMMIT
			//    (clearing file_changes makes the commit empty and it gets pruned, while preserving tree state)
			const filterRepoArgs = [
				...filesToFilter.flatMap((f) => ["--path", f]),
				"--invert-paths",
				"--commit-callback",
				// Clear file changes from commits with AGENCY_REMOVE_COMMIT marker
				// This makes the commit empty (which gets pruned) while preserving the tree state
				`if b"${AGENCY_REMOVE_COMMIT}" in commit.message: commit.file_changes = []`,
				"--force",
				"--refs",
				`${forkPoint}..${emitBranchName}`,
			]

			yield* filterRepo.run(gitRoot, filterRepoArgs, {
				env: { GIT_CONFIG_GLOBAL: "" },
			})

			verboseLog("git-filter-repo completed")

			// Switch back to source branch (git-filter-repo may have checked out the emit branch)
			yield* git.checkoutBranch(gitRoot, currentBranch)
		})

		yield* withSpinner(filterOperation, {
			text: "Filtering backpack files from branch history",
			successText: "Filtered backpack files from branch history",
			enabled: !options.silent && !verbose,
		})

		log(done(`Emitted ${highlight.branch(emitBranchName)}`))
	})

// Helper: Ensure emitBranch is set in agency.json metadata
const ensureEmitBranchInMetadata = (
	gitRoot: string,
	currentBranch: string,
	emitBranchName: string,
) =>
	Effect.gen(function* () {
		const git = yield* GitService

		// Read existing metadata
		const metadata = yield* Effect.tryPromise({
			try: () => readAgencyMetadata(gitRoot),
			catch: (error) => new Error(`Failed to read agency metadata: ${error}`),
		})

		// If no metadata exists, skip this step
		if (!metadata) {
			return
		}

		// If emitBranch is already set, nothing to do
		if (metadata.emitBranch) {
			return
		}

		// Add emitBranch to metadata
		const updatedMetadata = {
			...metadata,
			emitBranch: emitBranchName,
		}

		// Write updated metadata
		yield* Effect.tryPromise({
			try: () => writeAgencyMetadata(gitRoot, updatedMetadata),
			catch: (error) => new Error(`Failed to write agency metadata: ${error}`),
		})

		// Stage and commit the change
		yield* git.gitAdd(["agency.json"], gitRoot)
		// Note: baseBranch not available in this helper function context
		// This commit only happens when backfilling emitBranch in legacy repos
		yield* git.gitCommit(
			`chore: agency emit ${currentBranch} → ${emitBranchName}`,
			gitRoot,
			{ noVerify: true },
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

/**
 * Get the remote tracking branch name for a local branch.
 * Returns null if the branch doesn't track a remote.
 */
const getRemoteTrackingBranch = (
	git: GitService,
	gitRoot: string,
	localBranch: string,
) =>
	Effect.gen(function* () {
		const remote = yield* git
			.getGitConfig(`branch.${localBranch}.remote`, gitRoot)
			.pipe(Effect.option)

		const remoteBranch = yield* git
			.getGitConfig(`branch.${localBranch}.merge`, gitRoot)
			.pipe(Effect.option)

		if (
			remote._tag === "Some" &&
			remoteBranch._tag === "Some" &&
			remoteBranch.value
		) {
			return `${remote.value}/${remoteBranch.value.replace("refs/heads/", "")}`
		}

		return null
	})

/**
 * Find the best fork point by checking both local and remote tracking branches.
 *
 * Strategy:
 * 1. Get fork-point against the local base branch
 * 2. If base branch tracks a remote, also get fork-point against remote tracking branch
 * 3. Choose the more recent fork point (prefer remote if local is its ancestor)
 */
const findBestForkPoint = (
	gitRoot: string,
	featureBranch: string,
	baseBranch: string,
	verbose: boolean,
) =>
	Effect.gen(function* () {
		const git = yield* GitService
		const { verboseLog } = createLoggers({ verbose })

		// Strategy 1: Get fork-point against local base branch
		const localForkPoint = yield* getForkPointOrMergeBase(
			git,
			gitRoot,
			baseBranch,
			featureBranch,
		)
		verboseLog(
			`Fork-point with ${highlight.branch(baseBranch)}: ${highlight.commit(localForkPoint.substring(0, 8))}`,
		)

		// Strategy 2: Check if base branch tracks a remote
		const remoteTrackingBranch = yield* getRemoteTrackingBranch(
			git,
			gitRoot,
			baseBranch,
		)

		if (!remoteTrackingBranch) {
			return localForkPoint
		}

		// Get fork-point against remote tracking branch
		const remoteForkPoint = yield* getForkPointOrMergeBase(
			git,
			gitRoot,
			remoteTrackingBranch,
			featureBranch,
		)
		verboseLog(
			`Fork-point with ${highlight.branch(remoteTrackingBranch)}: ${highlight.commit(remoteForkPoint.substring(0, 8))}`,
		)

		// Strategy 3: Choose the more recent fork point
		// If local fork point is an ancestor of remote, prefer remote (it's more recent)
		const localIsAncestorOfRemote = yield* git.isAncestor(
			gitRoot,
			localForkPoint,
			remoteForkPoint,
		)

		if (localIsAncestorOfRemote) {
			verboseLog(
				`Using remote fork-point ${highlight.commit(remoteForkPoint.substring(0, 8))} (local is ancestor)`,
			)
			return remoteForkPoint
		}

		verboseLog(
			`Using local fork-point ${highlight.commit(localForkPoint.substring(0, 8))}`,
		)
		return localForkPoint
	})

// Helper: Create or reset branch
const createOrResetBranchEffect = (
	gitRoot: string,
	sourceBranch: string,
	targetBranch: string,
) =>
	Effect.gen(function* () {
		const git = yield* GitService

		const exists = yield* git.branchExists(gitRoot, targetBranch)
		const currentBranch = yield* git.getCurrentBranch(gitRoot)

		if (exists) {
			// If we're currently on the target branch, switch away first
			if (currentBranch === targetBranch) {
				yield* git.checkoutBranch(gitRoot, sourceBranch)
			}

			// Delete the existing branch
			yield* git.deleteBranch(gitRoot, targetBranch, true)
		}

		// Create new branch from source
		yield* git.createBranch(targetBranch, gitRoot, sourceBranch)

		return exists
	})

export const help = `
Usage: agency emit [base-branch] [options]

Create an emit branch from the current source branch with backpack files (AGENTS.md, TASK.md, etc.)
reverted to their state on the base branch.

Source and Emit Branches:
  - Source branches: Your working branches with agency-specific files (e.g., agency--feature-foo)
  - Emit branches: Clean branches suitable for PRs without agency files (e.g., feature-foo)
  
  This command creates a clean emit branch from your source branch by filtering out
  backpack files. Your source branch remains completely untouched.

Behavior:
  - If a file existed on the base branch: It is reverted to that version
  - If a file did NOT exist on base branch: It is completely removed
  - Only commits since the branch diverged are rewritten
  - This allows you to layer feature-specific instructions on top of base instructions
    during development, then remove those modifications when submitting code

Base Branch Selection:
  The command determines the base branch in this order:
  1. Explicitly provided base-branch argument
  2. Branch-specific base branch from agency.json (set by 'agency task')
  3. Repository-level default base branch from .git/config (all branches)
  4. Auto-detected from origin/HEAD or common branches (origin/main, origin/master, etc.)
  
  The base branch is set when you run 'agency task' to initialize a feature branch.
  Set a repository-level default with: agency base set --repo <branch>
  Update a branch's base branch with: agency base set <branch>

Prerequisites:
  - git-filter-repo must be installed: brew install git-filter-repo

Arguments:
  base-branch       Base branch to compare against (e.g., origin/main)
                    If not provided, will use saved config or prompt interactively

Options:
  --emit            Custom name for emit branch (defaults to pattern from config)
  --branch          (Deprecated: use --emit) Custom name for emit branch
  -f, --force       Force emit branch creation even if current branch looks like an emit branch

Configuration:
  ~/.config/agency/agency.json can contain:
  {
    "sourceBranchPattern": "agency--%branch%",  // Pattern for source branch names
    "emitBranch": "%branch%"                   // Pattern for emit branch names
  }
  
  Use %branch% as placeholder for the clean branch name.
  
  Source Pattern Examples:
    "agency--%branch%" -> main becomes agency--main (default)
    "wip/%branch%" -> feature becomes wip/feature
  
  Emit Pattern Examples:
    "%branch%" -> agency--main emits to main (default)
    "%branch%--PR" -> agency--feature emits to feature--PR
    "PR/%branch%" -> agency--feature emits to PR/feature

Examples:
  agency emit                          # Prompt for base branch (first time) or use saved
  agency emit origin/main              # Explicitly use origin/main as base branch
  agency emit --force                  # Force creation even from an emit branch

Notes:
  - Emit branch is created from your current branch (not the base)
  - Base branch is set when you run 'agency task' to initialize the feature branch
  - Only commits since the branch diverged are rewritten (uses merge-base range)
  - Backpack files are reverted to their merge-base state (or removed if they didn't exist)
  - All commits from the base branch remain unchanged (shared history is preserved)
  - Original branch is never modified
  - If emit branch exists, it will be deleted and recreated
  - Command will refuse to create emit branch from an emit branch unless --force is used
  
Important: If using a remote base branch (e.g., origin/main):
  - Always fetch before rebasing: git fetch origin && git rebase origin/main
  - Or use: git pull --rebase origin main
  - This ensures your local origin/main ref is up to date
  - If origin/main is stale when you rebase and emit, the emit branch may not be 
    properly based on the remote, requiring manual rebasing of the emit branch
`
