import {
	isInsideGitRepo,
	getGitRoot,
	getCurrentBranch,
	branchExists,
	getBaseBranchConfig,
} from "../utils/git"
import { loadConfig } from "../config"
import { extractSourceBranch, makePrBranchName } from "../utils/pr-branch"
import { pr } from "./pr"

export interface MergeOptions {
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

async function mergeBranch(
	gitRoot: string,
	branch: string,
	verbose: boolean,
): Promise<void> {
	const proc = Bun.spawn(["git", "merge", branch], {
		cwd: gitRoot,
		stdout: verbose ? "inherit" : "pipe",
		stderr: verbose ? "inherit" : "pipe",
	})

	await proc.exited

	if (proc.exitCode !== 0) {
		const stderr = verbose ? "" : await new Response(proc.stderr).text()
		throw new Error(
			`Failed to merge branch ${branch}${stderr ? `: ${stderr}` : ""}`,
		)
	}
}

export async function merge(options: MergeOptions = {}): Promise<void> {
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

	try {
		// Get current branch
		const currentBranch = await getCurrentBranch(gitRoot)

		verboseLog(`Current branch: ${currentBranch}`)

		// Check if we're on a PR branch
		const sourceBranch = extractSourceBranch(currentBranch, config.prBranch)

		let prBranchToMerge: string
		let baseBranchToMergeInto: string

		if (sourceBranch) {
			// We're on a PR branch - verify source branch exists
			verboseLog(
				`Current branch appears to be a PR branch for source: ${sourceBranch}`,
			)

			const sourceExists = await branchExists(gitRoot, sourceBranch)
			if (!sourceExists) {
				throw new Error(
					`Current branch '${currentBranch}' appears to be a PR branch, but source branch '${sourceBranch}' does not exist.\n` +
						`Cannot merge without a valid source branch.`,
				)
			}

			// Get the base branch that was configured when creating the PR
			const configuredBase = await getBaseBranchConfig(sourceBranch, gitRoot)
			if (!configuredBase) {
				throw new Error(
					`No base branch configuration found for source branch '${sourceBranch}'.\n` +
						`The PR branch may not have been created with 'agency pr', or configuration is missing.`,
				)
			}

			verboseLog(`Configured base branch: ${configuredBase}`)

			// For git operations (checkout/merge), use local branch name
			baseBranchToMergeInto = configuredBase.replace(/^origin\//, "")

			// Verify local base branch exists
			const baseExists = await branchExists(gitRoot, baseBranchToMergeInto)
			if (!baseExists) {
				throw new Error(
					`Base branch '${baseBranchToMergeInto}' does not exist locally.\n` +
						`You may need to checkout the branch first or update your base branch configuration.`,
				)
			}

			prBranchToMerge = currentBranch
		} else {
			// We're on a source branch - need to create/update PR branch first
			verboseLog(
				`Current branch appears to be a source branch, will create PR branch first`,
			)

			// Check if a corresponding PR branch already exists
			const prBranch = makePrBranchName(currentBranch, config.prBranch)
			const prExists = await branchExists(gitRoot, prBranch)

			if (prExists) {
				verboseLog(`PR branch '${prBranch}' already exists, will recreate it`)
			}

			// Run 'agency pr' to create/update the PR branch
			verboseLog(`Creating PR branch ${prBranch}...`)
			await pr({ silent: true, verbose })

			// Get the base branch from config
			const configuredBase = await getBaseBranchConfig(currentBranch, gitRoot)
			if (!configuredBase) {
				throw new Error(
					`Failed to determine base branch for '${currentBranch}' after running 'agency pr'.\n` +
						`This should not happen - please report this issue.`,
				)
			}

			verboseLog(`Configured base branch: ${configuredBase}`)

			// For git operations (checkout/merge), use local branch name
			baseBranchToMergeInto = configuredBase.replace(/^origin\//, "")

			// Verify local base branch exists
			const baseExists = await branchExists(gitRoot, baseBranchToMergeInto)
			if (!baseExists) {
				throw new Error(
					`Base branch '${baseBranchToMergeInto}' does not exist locally.\n` +
						`You may need to checkout the branch first or update your base branch configuration.`,
				)
			}

			prBranchToMerge = prBranch
		}

		// Now switch to the base branch
		verboseLog(`Switching to ${baseBranchToMergeInto}...`)
		await checkoutBranch(gitRoot, baseBranchToMergeInto)

		// Merge the PR branch
		verboseLog(`Merging ${prBranchToMerge} into ${baseBranchToMergeInto}...`)
		await mergeBranch(gitRoot, prBranchToMerge, verbose)

		log(`✓ Merged ${prBranchToMerge} into ${baseBranchToMergeInto}`)
	} catch (err) {
		// Re-throw errors for CLI handler to display
		throw err
	}
}

export const help = `
Usage: agency merge [options]

Merge the current PR branch into the configured base branch.

This command handles two scenarios:
  1. If on a PR branch (e.g., feature--PR): Switches to the base branch and merges the PR branch
  2. If on a source branch (e.g., feature): Runs 'agency pr' first to create/update the PR branch, then merges it

Behavior:
  - Automatically detects whether you're on a source or PR branch
  - Retrieves the configured base branch (e.g., 'main') from git config
  - Switches to the base branch
  - Merges the PR branch into the base branch
  - Leaves you on the base branch after merge

This is useful for local development workflows where you want to test merging
your clean PR branch (without AGENTS.md modifications) into the base branch
before pushing.

Prerequisites:
  - Must be on either a source branch or its corresponding PR branch
  - Base branch must exist locally
  - For source branches: Must have a corresponding PR branch or be able to create one

Options:
  -h, --help        Show this help message
  -s, --silent      Suppress output messages
  -v, --verbose     Show verbose output including git merge details

Examples:
  agency merge                   # From source branch: creates PR branch then merges
  agency merge                   # From PR branch: merges directly into base
  agency merge --verbose         # Merge with detailed output
  agency merge --silent          # Merge without output

Notes:
  - The command determines the base branch from git config (agency.pr.<branch>.baseBranch)
  - If you're on a source branch, 'agency pr' is run automatically
  - The PR branch must have both a source branch and base branch configured
  - After merge, you remain on the base branch
  - Merge conflicts must be resolved manually if they occur
`
