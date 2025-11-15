import {
	isInsideGitRepo,
	getGitRoot,
	branchExists,
	getCurrentBranch,
	setDefaultBaseBranchConfig,
} from "../utils/git"
import { setBaseBranchInMetadata } from "../types"
import { use } from "./use"
import highlight, { done } from "../utils/colors"

export interface SetOptions {
	subcommand?: string
	args: string[]
	repo?: boolean
	silent?: boolean
	verbose?: boolean
}

export interface SetBaseOptions {
	baseBranch: string
	repo?: boolean // If true, set repository-level default instead of branch-specific
	silent?: boolean
	verbose?: boolean
}

export interface SetTemplateOptions {
	template: string
	silent?: boolean
	verbose?: boolean
}

export async function setBase(options: SetBaseOptions): Promise<void> {
	const { baseBranch, repo = false, silent = false, verbose = false } = options
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
			`Base branch ${highlight.branch(baseBranch)} does not exist. Please provide a valid branch name.`,
		)
	}

	if (repo) {
		// Set repository-level default base branch in git config
		await setDefaultBaseBranchConfig(baseBranch, gitRoot)
		log(
			done(
				`Set repository-level default base branch to ${highlight.branch(baseBranch)}`,
			),
		)
	} else {
		// Set branch-specific base branch in agency.json
		const currentBranch = await getCurrentBranch(gitRoot)
		verboseLog(`Current branch: ${highlight.branch(currentBranch)}`)

		await setBaseBranchInMetadata(gitRoot, baseBranch)
		log(
			done(
				`Set base branch to ${highlight.branch(baseBranch)} for ${highlight.branch(currentBranch)}`,
			),
		)
	}
}

export async function setTemplate(options: SetTemplateOptions): Promise<void> {
	const { template, silent = false, verbose = false } = options

	// Delegate to the use() function which already handles all the logic
	await use({
		template,
		silent,
		verbose,
	})
}

export async function set(options: SetOptions): Promise<void> {
	const {
		subcommand,
		args,
		repo = false,
		silent = false,
		verbose = false,
	} = options

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
				repo,
				silent,
				verbose,
			})
			break
		}
		case "template": {
			if (!args[0]) {
				throw new Error(
					"Template name argument is required. Usage: agency set template <template-name>",
				)
			}
			await setTemplate({
				template: args[0],
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
Usage: agency set <subcommand> [options]

Set various configuration options for the current branch or repository.

Subcommands:
  base <branch>       Set the base branch for the current feature branch
  template <name>     Set the template for the current repository

Options for 'set base':
  --repo              Set repository-level default instead of branch-specific

Examples:
  agency set base origin/main         # Set base branch for current branch only
  agency set base --repo origin/main  # Set repository-level default for all branches
  agency set template work            # Set template to 'work'

Notes:
  - The base branch must exist in the repository
  - Branch-specific base branch is saved in agency.json (committed with the branch)
  - Repository-level default is saved in .git/config (not committed)
  - Branch-specific settings take precedence over repository-level defaults
  - The template setting is used by 'agency task' when initializing files
  - Base branch configuration is used by 'agency pr' when creating PR branches
`
