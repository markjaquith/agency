import {
	isInsideGitRepo,
	getGitRoot,
	setBaseBranchConfig,
	branchExists,
	getCurrentBranch,
} from "../utils/git"
import { use } from "./use"

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

export interface SetTemplateOptions {
	template: string
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
  base <branch>       Set the default base branch for the current feature branch
  template <name>     Set the template for the current repository

Examples:
  agency set base origin/main       # Set base branch to origin/main
  agency set template work          # Set template to 'work'

Notes:
  - The base branch must exist in the repository
  - Settings are saved in .git/config (not committed to the repository)
  - Each feature branch can have its own base branch configuration
  - The template setting is used by 'agency task' when initializing files
  - Base branch configuration is used by 'agency pr' when creating PR branches
`
