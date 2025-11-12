import {
	isInsideGitRepo,
	getGitRoot,
	setBaseBranchConfig,
	branchExists,
	getCurrentBranch,
} from "../utils/git"

export interface SetOptions {
	subcommand?: string
	args: string[]
	silent?: boolean
	verbose?: boolean
}

export interface SetBaseOptions {
	baseBranch: string
	silent?: boolean
	verbose?: boolean
}

export async function setBase(options: SetBaseOptions): Promise<void> {
	const { baseBranch, silent = false, verbose = false } = options
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

	// Validate that the base branch exists
	if (!(await branchExists(gitRoot, baseBranch))) {
		throw new Error(
			`Base branch '${baseBranch}' does not exist. Please provide a valid branch name.`,
		)
	}

	// Get current branch
	const currentBranch = await getCurrentBranch(gitRoot)
	verboseLog(`Current branch: ${currentBranch}`)

	// Save the base branch configuration
	await setBaseBranchConfig(currentBranch, baseBranch, gitRoot)

	log(`Set base branch for '${currentBranch}' to '${baseBranch}' in git config`)
}

export async function set(options: SetOptions): Promise<void> {
	const { subcommand, args, silent = false, verbose = false } = options

	if (!subcommand) {
		throw new Error("Subcommand is required. Usage: agency set <subcommand>")
	}

	switch (subcommand) {
		case "base": {
			if (!args[0]) {
				throw new Error(
					"Base branch argument is required. Usage: agency set base <base-branch>",
				)
			}
			await setBase({
				baseBranch: args[0],
				silent,
				verbose,
			})
			break
		}
		default:
			throw new Error(
				`Unknown subcommand '${subcommand}'. Available subcommands: base`,
			)
	}
}

export const help = `
Usage: agency set <subcommand> [options]

Set various configuration options for the current branch.

Subcommands:
  base <branch>     Set the default base branch for the current feature branch

Options:
  -h, --help        Show this help message
  -s, --silent      Suppress output messages
  -v, --verbose     Show verbose output

Examples:
  agency set base origin/main       # Set base branch to origin/main
  agency set base main              # Set base branch to main
  agency set base develop           # Set base branch to develop
  agency set base origin/main -v    # Set base branch with verbose output

Notes:
  - The base branch must exist in the repository
  - This setting is saved in .git/config for the current branch
  - Each feature branch can have its own base branch configuration
  - This configuration is used by 'agency pr' when creating PR branches
`
