import {
	isInsideGitRepo,
	getGitRoot,
	getBaseBranchConfig,
	getCurrentBranch,
} from "../utils/git"

export interface GetOptions {
	subcommand?: string
	silent?: boolean
	verbose?: boolean
}

export interface GetBaseOptions {
	silent?: boolean
	verbose?: boolean
}

export async function getBase(options: GetBaseOptions): Promise<void> {
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

	// Get current branch
	const currentBranch = await getCurrentBranch(gitRoot)
	verboseLog(`Current branch: ${currentBranch}`)

	// Get the base branch configuration
	const baseBranch = await getBaseBranchConfig(currentBranch, gitRoot)

	if (!baseBranch) {
		throw new Error(
			`No base branch configured for '${currentBranch}'. Use 'agency set base <branch>' to set one.`,
		)
	}

	log(baseBranch)
}

export async function get(options: GetOptions): Promise<void> {
	const { subcommand, silent = false, verbose = false } = options

	if (!subcommand) {
		throw new Error("Subcommand is required. Usage: agency get <subcommand>")
	}

	switch (subcommand) {
		case "base": {
			await getBase({
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
Usage: agency get <subcommand> [options]

Get various configuration options for the current branch.

Subcommands:
  base              Get the configured base branch for the current feature branch

Options:
  -h, --help        Show this help message
  -s, --silent      Suppress output messages
  -v, --verbose     Show verbose output

Examples:
  agency get base               # Get the base branch for current branch
  agency get base -v            # Get base branch with verbose output

Notes:
  - This command reads the base branch configuration from .git/config
  - If no base branch is configured, an error will be shown
  - Use 'agency set base <branch>' to configure a base branch
`
