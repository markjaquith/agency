import { isInsideGitRepo, getGitRoot, getCurrentBranch } from "../utils/git"
import { loadConfig } from "../config"
import { extractSourceBranch } from "../utils/pr-branch"
import highlight, { done } from "../utils/colors"

export interface SourceOptions {
	silent?: boolean
	verbose?: boolean
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

async function checkoutBranch(gitRoot: string, branch: string): Promise<void> {
	const proc = Bun.spawn(["git", "checkout", branch], {
		cwd: gitRoot,
		stdout: "pipe",
		stderr: "pipe",
	})

	await proc.exited

	if (proc.exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text()
		throw new Error(`Failed to checkout branch: ${stderr}`)
	}
}

export async function source(options: SourceOptions = {}): Promise<void> {
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

	// Load config
	const config = await loadConfig()

	// Get current branch
	const currentBranch = await getCurrentBranch(gitRoot)

	// Extract source branch name
	const sourceBranch = extractSourceBranch(currentBranch, config.prBranch)

	if (!sourceBranch) {
		throw new Error(`Not on a PR branch. Current branch: ${currentBranch}`)
	}

	// Check if source branch exists
	const exists = await branchExists(gitRoot, sourceBranch)
	if (!exists) {
		throw new Error(
			`Source branch ${highlight.branch(sourceBranch)} does not exist`,
		)
	}

	// Checkout source branch
	await checkoutBranch(gitRoot, sourceBranch)

	log(done(`Switched to source branch: ${highlight.branch(sourceBranch)}`))
}

export const help = `
Usage: agency source [options]

Switch back to the source branch from a PR branch.

This command extracts the source branch name from your current PR branch name
using the configured pattern, and switches back to it.

Example:
  agency source                  # From main--PR, switch to main

Notes:
  - Must be run from a PR branch
  - Source branch must exist
  - Uses PR branch pattern from ~/.config/agency/agency.json
`
