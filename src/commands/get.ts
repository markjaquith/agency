import {
	isInsideGitRepo,
	getGitRoot,
	getBaseBranchConfig,
	getCurrentBranch,
	getGitConfig,
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

export interface GetTemplateOptions {
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

export async function getTemplate(options: GetTemplateOptions): Promise<void> {
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

	verboseLog(`Git root: ${gitRoot}`)

	// Get the template configuration
	const template = await getGitConfig("agency.template", gitRoot)

	if (!template) {
		throw new Error(
			"No template configured for this repository. Use 'agency set template <name>' to set one.",
		)
	}

	log(template)
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
		case "template": {
			await getTemplate({
				silent,
				verbose,
			})
			break
		}
		default:
			throw new Error(
				`Unknown subcommand '${subcommand}'. Available subcommands: base, template`,
			)
	}
}

export const help = `
Usage: agency get <subcommand> [options]

Get various configuration options for the current branch.

Subcommands:
  base              Get the configured base branch for the current feature branch
  template          Get the configured template for the current repository

Options:
  -h, --help        Show this help message
  -s, --silent      Suppress output messages
  -v, --verbose     Show verbose output

Examples:
  agency get base               # Get the base branch for current branch
  agency get base -v            # Get base branch with verbose output
  agency get template           # Get the template for current repository
  agency get template -v        # Get template with verbose output

Notes:
  - This command reads configuration from .git/config
  - If no configuration is found, an error will be shown
  - Use 'agency set base <branch>' to configure a base branch
  - Use 'agency set template <name>' to configure a template
`
