import { Effect } from "effect"
import type { BaseCommandOptions } from "../utils/command"
import { GitService } from "../services/GitService"
import { ConfigService } from "../services/ConfigService"
import { FileSystemService } from "../services/FileSystemService"
import { makePrBranchName, extractSourceBranch } from "../utils/pr-branch"
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
} from "../utils/effect"

interface EmitOptions extends BaseCommandOptions {
	branch?: string
	baseBranch?: string
	force?: boolean
}

export const emit = (options: EmitOptions = {}) =>
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

		// Check if current branch looks like an emit branch already
		const possibleSourceBranch = extractSourceBranch(
			currentBranch,
			config.emitBranch,
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
					`Currently on emit branch ${highlight.branch(currentBranch)}, switching to source branch ${highlight.branch(possibleSourceBranch)}`,
				)
				yield* git.checkoutBranch(gitRoot, possibleSourceBranch)
				currentBranch = possibleSourceBranch
			}
		}

		// Check and update agency.json with emitBranch if needed
		yield* ensureEmitBranchInMetadata(gitRoot, currentBranch)

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

		// Determine emit branch name using config pattern
		const emitBranchName =
			options.branch || makePrBranchName(currentBranch, config.emitBranch)

		// Create or reset emit branch from current branch
		yield* createOrResetBranchEffect(gitRoot, currentBranch, emitBranchName)

		// Unset any remote tracking branch for the emit branch
		yield* git.unsetGitConfig(`branch.${emitBranchName}.remote`, gitRoot)
		yield* git.unsetGitConfig(`branch.${emitBranchName}.merge`, gitRoot)

		verboseLog(
			`Filtering backpack files from commits in range: ${highlight.commit(mergeBase.substring(0, 8))}..${highlight.branch(emitBranchName)}`,
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
			`${mergeBase}..${emitBranchName}`,
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

		// Switch back to source branch (git-filter-repo may have checked out the emit branch)
		yield* git.checkoutBranch(gitRoot, currentBranch)

		log(
			done(
				`Created ${highlight.branch(emitBranchName)} from ${highlight.branch(currentBranch)} (stayed on ${highlight.branch(currentBranch)})`,
			),
		)
	})

// Helper: Ensure emitBranch is set in agency.json metadata
const ensureEmitBranchInMetadata = (gitRoot: string, currentBranch: string) =>
	Effect.gen(function* () {
		const git = yield* GitService
		const fs = yield* FileSystemService

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

		// Determine the PR branch name that will be created
		const config = yield* ConfigService
		const configData = yield* config.loadConfig()
		const emitBranchName = makePrBranchName(
			currentBranch,
			configData.emitBranch,
		)

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
		yield* git.gitCommit("chore: agency emit", gitRoot)
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
	})

export const help = `
Usage: agency emit [base-branch] [options]

Create an emit branch from the current branch with backpack files (AGENTS.md, TASK.md, etc.)
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
  -b, --branch      Custom name for emit branch (defaults to pattern from config)
  -f, --force       Force emit branch creation even if current branch looks like an emit branch

Configuration:
  ~/.config/agency/agency.json can contain:
  {
    "emitBranch": "%branch%--PR"  // Pattern for emit branch names
  }
  
  Use %branch% as placeholder for source branch name.
  If %branch% is not present, pattern is treated as a suffix.
  
  Examples:
    "%branch%--PR" -> feature-foo becomes feature-foo--PR
    "PR/%branch%" -> feature-foo becomes PR/feature-foo
    "--PR" -> feature-foo becomes feature-foo--PR

Examples:
  agency emit                          # Prompt for base branch (first time) or use saved
  agency emit origin/main              # Explicitly use origin/main as base branch
  agency emit --force                  # Force creation even from an emit branch

Notes:
  - Emit branch is created from your current branch (not the base)
  - Base branch is set when you run 'agency task' to initialize the feature branch
  - Only commits since the branch diverged are rewritten (uses merge-base range)
  - Backpack files are reverted to their merge-base state (or removed if they didn't exist)
  - Only commits from the base branch remain unchanged (shared history is preserved)
  - All commits from the base branch remain unchanged (shared history is preserved)
  - Original branch is never modified
  - If emit branch exists, it will be deleted and recreated
   - Command will refuse to create emit branch from an emit branch unless --force is used
`
