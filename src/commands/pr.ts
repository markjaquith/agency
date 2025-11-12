import {
	isInsideGitRepo,
	getGitRoot,
	getBaseBranchConfig,
	setBaseBranchConfig,
	branchExists,
	getCurrentBranch,
} from "../utils/git"
import { loadConfig } from "../config"
import { makePrBranchName, extractSourceBranch } from "../utils/pr-branch"
import { initializeManagedFiles } from "../types"

export interface PrOptions {
	branch?: string
	baseBranch?: string
	silent?: boolean
	force?: boolean
	verbose?: boolean
}

async function checkGitFilterRepo(): Promise<boolean> {
	const proc = Bun.spawn(["which", "git-filter-repo"], {
		stdout: "pipe",
		stderr: "pipe",
	})

	await proc.exited
	return proc.exitCode === 0
}

async function getDefaultRemoteBranch(gitRoot: string): Promise<string | null> {
	// Check what origin/HEAD points to
	const proc = Bun.spawn(["git", "rev-parse", "--abbrev-ref", "origin/HEAD"], {
		cwd: gitRoot,
		stdout: "pipe",
		stderr: "pipe",
	})

	await proc.exited

	if (proc.exitCode === 0) {
		const output = await new Response(proc.stdout).text()
		return output.trim()
	}

	return null
}

async function getBaseBranch(
	gitRoot: string,
	currentBranch: string,
	providedBaseBranch?: string,
): Promise<string> {
	// If explicitly provided, use it
	if (providedBaseBranch) {
		// Verify it exists
		if (!(await branchExists(gitRoot, providedBaseBranch))) {
			throw new Error(
				`Provided base branch '${providedBaseBranch}' does not exist`,
			)
		}
		return providedBaseBranch
	}

	// Check if we have a saved base branch in git config
	const savedBaseBranch = await getBaseBranchConfig(currentBranch, gitRoot)
	if (savedBaseBranch && (await branchExists(gitRoot, savedBaseBranch))) {
		return savedBaseBranch
	}

	// Try to auto-detect the default remote branch
	const defaultRemote = await getDefaultRemoteBranch(gitRoot)
	if (defaultRemote && (await branchExists(gitRoot, defaultRemote))) {
		return defaultRemote
	}

	// Try common base branches in order
	const commonBases = ["origin/main", "origin/master", "main", "master"]
	for (const base of commonBases) {
		if (await branchExists(gitRoot, base)) {
			return base
		}
	}

	// Could not auto-detect, require explicit specification
	throw new Error(
		"Could not auto-detect base branch. Please specify one explicitly with: agency pr <base-branch>",
	)
}

async function getMergeBase(
	gitRoot: string,
	branch1: string,
	branch2: string,
): Promise<string> {
	const proc = Bun.spawn(["git", "merge-base", branch1, branch2], {
		cwd: gitRoot,
		stdout: "pipe",
		stderr: "pipe",
	})

	await proc.exited

	if (proc.exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text()
		throw new Error(`Failed to find merge base: ${stderr}`)
	}

	const output = await new Response(proc.stdout).text()
	return output.trim()
}

async function createOrResetBranch(
	gitRoot: string,
	sourceBranch: string,
	targetBranch: string,
): Promise<void> {
	const exists = await branchExists(gitRoot, targetBranch)
	const currentBranch = await getCurrentBranch(gitRoot)

	if (exists) {
		// If we're currently on the target branch, switch away first
		if (currentBranch === targetBranch) {
			const switchProc = Bun.spawn(["git", "checkout", sourceBranch], {
				cwd: gitRoot,
				stdout: "pipe",
				stderr: "pipe",
			})
			await switchProc.exited
			if (switchProc.exitCode !== 0) {
				const stderr = await new Response(switchProc.stderr).text()
				throw new Error(`Failed to switch away from branch: ${stderr}`)
			}
		}

		// Delete the existing branch
		const deleteProc = Bun.spawn(["git", "branch", "-D", targetBranch], {
			cwd: gitRoot,
			stdout: "pipe",
			stderr: "pipe",
		})
		await deleteProc.exited
		if (deleteProc.exitCode !== 0) {
			const stderr = await new Response(deleteProc.stderr).text()
			throw new Error(`Failed to delete branch: ${stderr}`)
		}
	}

	// Create new branch from source
	const proc = Bun.spawn(
		["git", "checkout", "-b", targetBranch, sourceBranch],
		{
			cwd: gitRoot,
			stdout: "pipe",
			stderr: "pipe",
		},
	)

	await proc.exited

	if (proc.exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text()
		throw new Error(`Failed to create branch: ${stderr}`)
	}
}

export async function pr(options: PrOptions = {}): Promise<void> {
	// Initialize MANAGED_FILES from template files
	const managedFiles = await initializeManagedFiles()

	const { silent = false, force = false, verbose = false } = options
	const log = silent ? () => {} : console.log
	const verboseLog = verbose && !silent ? console.log : () => {}

	// Check if in a git repository
	if (!(await isInsideGitRepo(process.cwd()))) {
		throw new Error(
			"Not in a git repository. Please run this command inside a git repo.",
		)
	}

	const gitRoot = await getGitRoot(process.cwd())
	if (!gitRoot) {
		throw new Error("Failed to determine the root of the git repository.")
	}

	// Check if git-filter-repo is installed
	if (!(await checkGitFilterRepo())) {
		const isMac = process.platform === "darwin"
		const installInstructions = isMac
			? "Please install it via Homebrew: brew install git-filter-repo"
			: "Please install it using your package manager. See: https://github.com/newren/git-filter-repo/blob/main/INSTALL.md"
		throw new Error(`git-filter-repo is not installed. ${installInstructions}`)
	}

	// Load config
	const config = await loadConfig()

	try {
		// Get current branch
		const currentBranch = await getCurrentBranch(gitRoot)

		// Check if current branch looks like a PR branch already
		const possibleSourceBranch = extractSourceBranch(
			currentBranch,
			config.prBranch,
		)
		if (possibleSourceBranch && !force) {
			// Check if the possible source branch exists
			const sourceExists = await branchExists(gitRoot, possibleSourceBranch)
			if (sourceExists) {
				throw new Error(
					`Current branch '${currentBranch}' appears to be a PR branch for '${possibleSourceBranch}'.\n` +
						`Creating a PR branch from a PR branch is likely a mistake.\n` +
						`Use --force to override this check.`,
				)
			}
		}

		// Find the base branch this was created from
		const baseBranch = await getBaseBranch(
			gitRoot,
			currentBranch,
			options.baseBranch,
		)

		verboseLog(`Using base branch: ${baseBranch}`)

		// Save the base branch to git config for future runs
		if (!options.baseBranch) {
			// Only save if it was auto-detected or prompted, not if explicitly provided each time
			const savedBaseBranch = await getBaseBranchConfig(currentBranch, gitRoot)
			if (!savedBaseBranch || savedBaseBranch !== baseBranch) {
				await setBaseBranchConfig(currentBranch, baseBranch, gitRoot)
				verboseLog(`Saved base branch '${baseBranch}' to git config`)
			}
		}

		// Get the merge-base (where the branch diverged)
		const mergeBase = await getMergeBase(gitRoot, currentBranch, baseBranch)

		verboseLog(`Branch diverged at commit: ${mergeBase}`)

		// Determine PR branch name using config pattern
		const prBranch =
			options.branch || makePrBranchName(currentBranch, config.prBranch)

		log(`Creating ${prBranch} from ${currentBranch}...`)

		// Create or reset PR branch from current branch
		await createOrResetBranch(gitRoot, currentBranch, prBranch)

		// Run git-filter-repo to remove files from history on the PR branch
		// Use --refs with a range to only rewrite commits since the merge-base
		// This preserves the state of managed files as they were on the base branch,
		// while removing any modifications made on the feature branch

		verboseLog(
			`Filtering managed files from commits in range: ${mergeBase.substring(0, 8)}..${prBranch}`,
		)
		verboseLog(
			`Files will revert to their state at merge-base (base branch: ${baseBranch})`,
		)

		// Clean up .git/filter-repo directory to avoid interactive prompts
		// about continuing from a previous run
		const filterRepoDir = `${gitRoot}/.git/filter-repo`
		try {
			await Bun.spawn(["rm", "-rf", filterRepoDir], {
				cwd: gitRoot,
				stdout: "pipe",
				stderr: "pipe",
			}).exited
			verboseLog("Cleaned up previous git-filter-repo state")
		} catch {
			// Ignore errors if directory doesn't exist
		}

		// Set GIT_CONFIG_GLOBAL to empty to avoid parsing issues with global git config
		// See: https://github.com/newren/git-filter-repo/issues/512
		const env = { ...process.env, GIT_CONFIG_GLOBAL: "" }

		const filterRepoArgs = [
			"git",
			"filter-repo",
			...managedFiles.flatMap((f) => ["--path", f.name]),
			"--invert-paths",
			"--force",
			"--refs",
			`${mergeBase}..${prBranch}`,
		]

		const proc = Bun.spawn(filterRepoArgs, {
			cwd: gitRoot,
			stdout: verbose ? "inherit" : "pipe",
			stderr: "pipe",
			env,
		})

		await proc.exited

		if (verbose) {
			verboseLog("git-filter-repo completed")
		}

		if (proc.exitCode !== 0) {
			const stderr = await new Response(proc.stderr).text()
			throw new Error(`git-filter-repo failed: ${stderr}`)
		}

		log(`Created ${prBranch} from ${currentBranch}`)
	} catch (err) {
		// Re-throw errors for CLI handler to display
		throw err
	}
}

export const help = `
Usage: agency pr [base-branch] [options]

Create a PR branch from the current branch with managed files (AGENTS.md)
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
  2. Previously saved base branch from git config (agency.pr.<branch>.baseBranch)
  3. Interactive prompt with smart suggestions (origin/main, origin/master, etc.)
  
  Once selected, the base branch is saved to git config for future runs.
  You can change the saved base branch using: agency set-base <new-base-branch>

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
  - Base branch is saved to git config after first selection
  - Only commits since the branch diverged are rewritten (uses merge-base range)
  - Managed files are reverted to their merge-base state (or removed if they didn't exist)
  - Only commits since divergence that touched these files will have different hashes
  - All commits from the base branch remain unchanged (shared history is preserved)
  - Original branch is never modified
  - If PR branch exists, it will be deleted and recreated
  - Command will refuse to create PR branch from a PR branch unless --force is used
`
