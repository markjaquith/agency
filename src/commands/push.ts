import { isInsideGitRepo, getGitRoot, getCurrentBranch } from "../utils/git"
import { pr } from "./pr"
import { extractSourceBranch } from "../utils/pr-branch"
import { loadConfig } from "../config"
import highlight, { done } from "../utils/colors"

export interface PushOptions {
	baseBranch?: string
	branch?: string
	silent?: boolean
	force?: boolean
	verbose?: boolean
}

export async function push(options: PushOptions = {}): Promise<void> {
	const { silent = false, verbose = false } = options
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

	// Load config to check PR branch pattern
	const config = await loadConfig()

	// Get current branch (this is our source branch we'll return to)
	const sourceBranch = await getCurrentBranch(gitRoot)

	// Check if we're already on a PR branch
	const isOnPrBranch = extractSourceBranch(sourceBranch, config.prBranch)

	// If we're on a PR branch, throw an error
	if (isOnPrBranch) {
		throw new Error(
			`Already on PR branch ${highlight.branch(sourceBranch)}. ` +
				`Run 'agency source' first to switch to the source branch, then run 'agency push'.`,
		)
	}

	verboseLog(`Starting push workflow from ${highlight.branch(sourceBranch)}`)

	// Step 1: Create PR branch (agency pr)
	verboseLog("Step 1: Creating PR branch...")
	await pr({
		baseBranch: options.baseBranch,
		branch: options.branch,
		silent: true, // Suppress pr command output, we'll provide our own
		force: options.force,
		verbose: options.verbose,
	})

	// Get the PR branch name that was created
	const prBranchName = await getCurrentBranch(gitRoot)
	log(done(`Created PR branch: ${highlight.branch(prBranchName)}`))

	// Step 2: Push to remote (git push)
	verboseLog(`Step 2: Pushing ${highlight.branch(prBranchName)} to remote...`)

	const pushProc = Bun.spawn(["git", "push", "-u", "origin", prBranchName], {
		cwd: gitRoot,
		stdout: verbose ? "inherit" : "pipe",
		stderr: "pipe",
	})

	await pushProc.exited

	if (pushProc.exitCode !== 0) {
		const stderr = await new Response(pushProc.stderr).text()
		throw new Error(`Failed to push branch to remote: ${stderr}`)
	}

	log(done(`Pushed ${highlight.branch(prBranchName)} to origin`))

	// Step 3: Switch back to source branch
	// We switch back directly to the source branch we started on,
	// rather than using the source command, to support custom branch names
	verboseLog("Step 3: Switching back to source branch...")

	const checkoutProc = Bun.spawn(["git", "checkout", sourceBranch], {
		cwd: gitRoot,
		stdout: "pipe",
		stderr: "pipe",
	})

	await checkoutProc.exited

	if (checkoutProc.exitCode !== 0) {
		const stderr = await new Response(checkoutProc.stderr).text()
		throw new Error(`Failed to switch back to source branch: ${stderr}`)
	}

	log(done(`Switched back to source branch: ${highlight.branch(sourceBranch)}`))
}

export const help = `
Usage: agency push [base-branch] [options]

Create a PR branch, push it to remote, and return to the source branch.

This command is a convenience wrapper that runs three operations in sequence:
  1. agency pr [base-branch]  - Create PR branch with managed files reverted
  2. git push -u origin <pr-branch>  - Push PR branch to remote
  3. git checkout <source-branch>  - Switch back to source branch

The command ensures you end up back on your source branch after pushing
the PR branch, making it easy to continue working locally while having
a clean PR branch ready on the remote.

Base Branch Selection:
  Same as 'agency pr' - see 'agency pr --help' for details

Prerequisites:
  - git-filter-repo must be installed: brew install git-filter-repo
  - Remote 'origin' must be configured

Arguments:
  base-branch       Base branch to compare against (e.g., origin/main)
                    If not provided, will use saved config or auto-detect

Options:
  -b, --branch      Custom name for PR branch (defaults to pattern from config)
  -f, --force       Force PR branch creation even if current branch looks like a PR branch

Examples:
  agency push                          # Create PR, push, return to source
  agency push origin/main              # Explicitly use origin/main as base
  agency push --force                  # Force creation even from a PR-like branch

Notes:
  - Must be run from a source branch (not a PR branch)
  - Creates or recreates the PR branch
  - Pushes with -u flag to set up tracking
  - Automatically returns to source branch after pushing
  - If any step fails, the command stops and reports the error
`
