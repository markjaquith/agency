import { isInsideGitRepo, getGitRoot } from "../utils/git"
import { loadConfig } from "../config"
import { makePrBranchName, extractSourceBranch } from "../utils/pr-branch"
import { MANAGED_FILES } from "../types"

export interface PrOptions {
	branch?: string
	silent?: boolean
	force?: boolean
	verbose?: boolean
}

async function getCurrentBranch(gitRoot: string): Promise<string> {
	const proc = Bun.spawn(["git", "branch", "--show-current"], {
		cwd: gitRoot,
		stdout: "pipe",
		stderr: "pipe",
	})

	await proc.exited

	if (proc.exitCode !== 0) {
		throw new Error("Failed to get current branch")
	}

	const output = await new Response(proc.stdout).text()
	return output.trim()
}

async function branchExists(gitRoot: string, branch: string): Promise<boolean> {
	const proc = Bun.spawn(["git", "rev-parse", "--verify", branch], {
		cwd: gitRoot,
		stdout: "pipe",
		stderr: "pipe",
	})

	await proc.exited
	return proc.exitCode === 0
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
): Promise<string | null> {
	// Try to find the upstream branch
	const upstreamProc = Bun.spawn(
		["git", "rev-parse", "--abbrev-ref", `${currentBranch}@{upstream}`],
		{
			cwd: gitRoot,
			stdout: "pipe",
			stderr: "pipe",
		},
	)

	await upstreamProc.exited

	if (upstreamProc.exitCode === 0) {
		const upstream = await new Response(upstreamProc.stdout).text()
		return upstream.trim()
	}

	// Check what the actual default remote branch is
	const defaultRemote = await getDefaultRemoteBranch(gitRoot)
	if (defaultRemote && (await branchExists(gitRoot, defaultRemote))) {
		return defaultRemote
	}

	// Try common base branches in order
	const commonBases = ["origin/main", "origin/master", "main", "master"]

	for (const base of commonBases) {
		const exists = await branchExists(gitRoot, base)
		if (exists) {
			return base
		}
	}

	return null
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

	if (exists) {
		// Delete and recreate the branch
		await Bun.spawn(["git", "branch", "-D", targetBranch], {
			cwd: gitRoot,
			stdout: "pipe",
			stderr: "pipe",
		}).exited
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
		const baseBranch = await getBaseBranch(gitRoot, currentBranch)

		if (!baseBranch) {
			throw new Error(
				"Could not determine base branch. Tried: origin/main, origin/master, main, master",
			)
		}

		verboseLog(`Using base branch: ${baseBranch}`)

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

		// Set GIT_CONFIG_GLOBAL to empty to avoid parsing issues with global git config
		// See: https://github.com/newren/git-filter-repo/issues/512
		const env = { ...process.env, GIT_CONFIG_GLOBAL: "" }

		const filterRepoArgs = [
			"git",
			"filter-repo",
			...MANAGED_FILES.flatMap((f) => ["--path", f.name]),
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
Usage: agency pr [branch] [options]

Create a PR branch from the current branch with managed files (AGENTS.md, CLAUDE.md)
reverted to their state on the base branch.

This command creates a new branch (or recreates it if it exists) based on your current
branch, then uses git-filter-repo to revert AGENTS.md and CLAUDE.md to their state at
the point where your branch diverged from the base branch (main/master). Your original
branch remains completely untouched.

Behavior:
  - If these files existed on the base branch: They are reverted to that version
  - If these files did NOT exist on base branch: They are completely removed
  - Only commits since the branch diverged are rewritten
  - This allows you to layer feature-specific instructions on top of base instructions
    during development, then remove those modifications when creating a PR

The command intelligently detects your repository's default branch (main or master) by
checking origin/HEAD, then finds the merge-base where your branch diverged.

Prerequisites:
  - git-filter-repo must be installed: brew install git-filter-repo

Arguments:
  branch            Target branch name (defaults to pattern from config)

Options:
  -h, --help        Show this help message
  -s, --silent      Suppress output messages
  -f, --force       Force PR branch creation even if current branch looks like a PR branch
  -v, --verbose     Show verbose output including git-filter-repo execution details

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
  agency pr                      # Create PR branch with default name
  agency pr feature-pr           # Create PR branch with custom name
  agency pr --force              # Force creation even from a PR branch
  agency pr --verbose            # Create PR branch with verbose debugging output
  agency pr --silent             # Create PR branch without output
  agency pr --help               # Show this help message

Notes:
  - PR branch is created from your current branch (not main)
  - Only commits since the branch diverged are rewritten (uses merge-base range)
  - Managed files are reverted to their merge-base state (or removed if they didn't exist)
  - Only commits since divergence that touched these files will have different hashes
  - All commits from the base branch remain unchanged (shared history is preserved)
  - Original branch is never modified
  - If PR branch exists, it will be deleted and recreated
  - Command will refuse to create PR branch from a PR branch unless --force is used
  - Use --verbose to see which base branch and merge-base commit are detected
  - Use --verbose to debug git-filter-repo if it fails
`
