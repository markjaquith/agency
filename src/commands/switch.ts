import {
	isInsideGitRepo,
	getGitRoot,
	getCurrentBranch,
	branchExists,
} from "../utils/git"
import { loadConfig } from "../config"
import { extractSourceBranch, makePrBranchName } from "../utils/pr-branch"
import highlight, { done } from "../utils/colors"

export interface SwitchOptions {
	silent?: boolean
	verbose?: boolean
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

export async function switchBranch(options: SwitchOptions = {}): Promise<void> {
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

	// Try to extract source branch (are we on a PR branch?)
	const sourceBranch = extractSourceBranch(currentBranch, config.prBranch)

	if (sourceBranch) {
		// We're on a PR branch, switch to source
		const exists = await branchExists(gitRoot, sourceBranch)
		if (!exists) {
			throw new Error(
				`Source branch ${highlight.branch(sourceBranch)} does not exist`,
			)
		}

		await checkoutBranch(gitRoot, sourceBranch)
		log(done(`Switched to source branch: ${highlight.branch(sourceBranch)}`))
	} else {
		// We're on a source branch, switch to PR branch
		const prBranch = makePrBranchName(currentBranch, config.prBranch)

		const exists = await branchExists(gitRoot, prBranch)
		if (!exists) {
			throw new Error(
				`PR branch ${highlight.branch(prBranch)} does not exist. Run 'agency pr' to create it.`,
			)
		}

		await checkoutBranch(gitRoot, prBranch)
		log(done(`Switched to PR branch: ${highlight.branch(prBranch)}`))
	}
}

export const help = `
Usage: agency switch [options]

Toggle between source branch and PR branch.

This command intelligently switches between your source branch and its
corresponding PR branch:
  - If on a PR branch (e.g., main--PR), switches to source (main)
  - If on a source branch (e.g., main), switches to PR branch (main--PR)

Example:
  agency switch                  # Toggle between branches

Notes:
  - Target branch must exist
  - Uses PR branch pattern from ~/.config/agency/agency.json
  - If PR branch doesn't exist, run 'agency pr' to create it
`
