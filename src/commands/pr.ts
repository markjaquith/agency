import { Effect } from "effect"
import type { BaseCommandOptions } from "../utils/command"
import { GitService } from "../services/GitService"
import { ConfigService } from "../services/ConfigService"
import { FileSystemService } from "../services/FileSystemService"
import { makePrBranchName, extractSourceBranch } from "../utils/pr-branch"
import { getFilesToFilter } from "../types"
import highlight, { done } from "../utils/colors"
import {
	createLoggers,
	ensureGitRepo,
	resolveBaseBranch,
} from "../utils/effect"

interface PrOptions extends BaseCommandOptions {
	branch?: string
	baseBranch?: string
	force?: boolean
}

export const pr = (options: PrOptions = {}) =>
	Effect.gen(function* () {
		const { force = false, verbose = false } = options
		const { log, verboseLog } = createLoggers(options)

		const git = yield* GitService
		const configService = yield* ConfigService
		const fs = yield* FileSystemService

		const gitRoot = yield* ensureGitRepo()

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

		// Load config
		const config = yield* configService.loadConfig()

		// Get current branch
		let currentBranch = yield* git.getCurrentBranch(gitRoot)

		// Check if current branch looks like a PR branch already
		const possibleSourceBranch = extractSourceBranch(
			currentBranch,
			config.prBranch,
		)
		if (possibleSourceBranch) {
			// Check if the possible source branch exists
			const sourceExists = yield* git.branchExists(
				gitRoot,
				possibleSourceBranch,
			)
			if (sourceExists) {
				// Switch to the source branch and continue
				verboseLog(
					`Currently on PR branch ${highlight.branch(currentBranch)}, switching to source branch ${highlight.branch(possibleSourceBranch)}`,
				)
				yield* git.checkoutBranch(gitRoot, possibleSourceBranch)
				currentBranch = possibleSourceBranch
			}
		}

		// Find the base branch this was created from
		const baseBranch = yield* resolveBaseBranch(gitRoot, options.baseBranch)

		verboseLog(`Using base branch: ${highlight.branch(baseBranch)}`)

		// Get the merge-base (where the branch diverged)
		const mergeBase = yield* git.getMergeBase(
			gitRoot,
			currentBranch,
			baseBranch,
		)

		verboseLog(`Branch diverged at commit: ${highlight.commit(mergeBase)}`)

		// Determine PR branch name using config pattern
		const prBranchName =
			options.branch || makePrBranchName(currentBranch, config.prBranch)

		// Create or reset PR branch from current branch
		yield* createOrResetBranchEffect(gitRoot, currentBranch, prBranchName)

		// Unset any remote tracking branch for the PR branch
		yield* git.unsetGitConfig(`branch.${prBranchName}.remote`, gitRoot)
		yield* git.unsetGitConfig(`branch.${prBranchName}.merge`, gitRoot)

		verboseLog(
			`Filtering backpack files from commits in range: ${highlight.commit(mergeBase.substring(0, 8))}..${highlight.branch(prBranchName)}`,
		)
		verboseLog(
			`Files will revert to their state at merge-base (base branch: ${highlight.branch(baseBranch)})`,
		)

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

		// Run git-filter-repo
		const filterRepoArgs = [
			"git",
			"filter-repo",
			...filesToFilter.flatMap((f) => ["--path", f]),
			"--invert-paths",
			"--force",
			"--refs",
			`${mergeBase}..${prBranchName}`,
		]

		const result = yield* git.runGitCommand(filterRepoArgs, gitRoot, {
			env: { GIT_CONFIG_GLOBAL: "" },
			captureOutput: true,
		})

		verboseLog("git-filter-repo completed")

		if (result.exitCode !== 0) {
			return yield* Effect.fail(
				new Error(`git-filter-repo failed: ${result.stderr}`),
			)
		}

		log(
			done(
				`Created ${highlight.branch(prBranchName)} from ${highlight.branch(currentBranch)}`,
			),
		)
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
		yield* git.checkoutBranch(gitRoot, targetBranch)
	})

export const help = `
Usage: agency pr [base-branch] [options]

Create a PR branch from the current branch with backpack files (AGENTS.md, TASK.md, etc.)
reverted to their state on the base branch.

This command creates a new branch (or recreates it if it exists) based on your current
branch, then uses git-filter-repo to revert AGENTS.md to its state at
the point where your branch diverged from the base branch. Your original branch remains
completely untouched.

Behavior:
   - If this file existed on the base branch: It is reverted to that version
   - If this file did NOT exist on base branch: It is completely removed
  - Only commits since the branch diverged are rewritten
  - This allows you to layer feature-specific instructions on top of base instructions
    during development, then remove those modifications when creating a PR

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
  -b, --branch      Custom name for PR branch (defaults to pattern from config)
  -f, --force       Force PR branch creation even if current branch looks like a PR branch

Configuration:
  ~/.config/agency/agency.json can contain:
  {
    "prBranch": "%branch%--PR"  // Pattern for PR branch names
  }
  
  Use %branch% as placeholder for source branch name.
  If %branch% is not present, pattern is treated as a suffix.
  
  Examples:
    "%branch%--PR" -> feature-foo becomes feature-foo--PR
    "PR/%branch%" -> feature-foo becomes PR/feature-foo
    "--PR" -> feature-foo becomes feature-foo--PR

Examples:
  agency pr                          # Prompt for base branch (first time) or use saved
  agency pr origin/main              # Explicitly use origin/main as base branch
  agency pr --force                  # Force creation even from a PR branch

Notes:
  - PR branch is created from your current branch (not the base)
  - Base branch is set when you run 'agency task' to initialize the feature branch
  - Only commits since the branch diverged are rewritten (uses merge-base range)
  - Backpack files are reverted to their merge-base state (or removed if they didn't exist)
  - Only commits from the base branch remain unchanged (shared history is preserved)
  - All commits from the base branch remain unchanged (shared history is preserved)
  - Original branch is never modified
  - If PR branch exists, it will be deleted and recreated
   - Command will refuse to create PR branch from a PR branch unless --force is used
`
