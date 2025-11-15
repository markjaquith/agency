import {
	isInsideGitRepo,
	getGitRoot,
	getCurrentBranch,
	getGitConfig,
	getDefaultBaseBranchConfig,
} from "../utils/git"
import { getBaseBranchFromMetadata } from "../types"
import highlight from "../utils/colors"

export interface GetOptions {
	subcommand?: string
	silent?: boolean
	verbose?: boolean
	repo?: boolean
}

export interface GetBaseOptions {
	silent?: boolean
	verbose?: boolean
	repo?: boolean
}

export interface GetTemplateOptions {
	silent?: boolean
	verbose?: boolean
}

export async function getBase(options: GetBaseOptions): Promise<void> {
	const { silent = false, verbose = false, repo = false } = options
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

	let baseBranch: string | null

	if (repo) {
		// Get repository-level default base branch from git config
		verboseLog("Reading repository-level default base branch from git config")
		baseBranch = await getDefaultBaseBranchConfig(gitRoot)

		if (!baseBranch) {
			throw new Error(
				"No repository-level base branch configured. Use 'agency set base --repo <branch>' to set one.",
			)
		}
	} else {
		// Get current branch
		const currentBranch = await getCurrentBranch(gitRoot)
		verboseLog(`Current branch: ${highlight.branch(currentBranch)}`)

		// Get branch-specific base branch from agency.json
		verboseLog("Reading branch-specific base branch from agency.json")
		baseBranch = await getBaseBranchFromMetadata(gitRoot)

		if (!baseBranch) {
			throw new Error(
				`No base branch configured for ${highlight.branch(currentBranch)}. Use 'agency set base <branch>' to set one.`,
			)
		}
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
	const { subcommand, silent = false, verbose = false, repo = false } = options

	if (!subcommand) {
		throw new Error("Subcommand is required. Usage: agency get <subcommand>")
	}

	switch (subcommand) {
		case "base": {
			await getBase({
				silent,
				verbose,
				repo,
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

Get various configuration options for the current branch or repository.

Subcommands:
  base              Get the configured base branch for the current feature branch
  template          Get the configured template for the current repository

Options:
  --repo            Get repository-level default (base subcommand only)

Examples:
  agency get base               # Get branch-specific base branch from agency.json
  agency get base --repo        # Get repository-level default base branch
  agency get template           # Get the template for current repository

Notes:
  - 'agency get base' reads from the current branch's agency.json file
  - 'agency get base --repo' reads the repository-level default from .git/config
  - 'agency get template' reads from .git/config
  - If no configuration is found, an error will be shown
  - Use 'agency set base <branch>' to configure a branch-specific base branch
  - Use 'agency set base --repo <branch>' to configure a repository-level default
  - Use 'agency set template <name>' to configure a template
`
