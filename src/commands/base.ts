import {
	isInsideGitRepo,
	getGitRoot,
	branchExists,
	getCurrentBranch,
	setDefaultBaseBranchConfig,
	getDefaultBaseBranchConfig,
} from "../utils/git"
import { setBaseBranchInMetadata, getBaseBranchFromMetadata } from "../types"
import highlight, { done } from "../utils/colors"

export interface BaseOptions {
	subcommand?: string
	args: string[]
	repo?: boolean
	silent?: boolean
	verbose?: boolean
}

export interface BaseSetOptions {
	baseBranch: string
	repo?: boolean
	silent?: boolean
	verbose?: boolean
}

export interface BaseGetOptions {
	repo?: boolean
	silent?: boolean
	verbose?: boolean
}

export async function baseSet(options: BaseSetOptions): Promise<void> {
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

export async function baseGet(options: BaseGetOptions): Promise<void> {
	const { repo = false, silent = false, verbose = false } = options
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

	let currentBase: string | null

	if (repo) {
		// Get repository-level default base branch from git config
		verboseLog("Reading repository-level default base branch from git config")
		currentBase = await getDefaultBaseBranchConfig(gitRoot)

		if (!currentBase) {
			throw new Error(
				"No repository-level base branch configured. Use 'agency base set --repo <branch>' to set one.",
			)
		}
	} else {
		// Get current branch
		const currentBranch = await getCurrentBranch(gitRoot)
		verboseLog(`Current branch: ${highlight.branch(currentBranch)}`)

		// Get branch-specific base branch from agency.json
		verboseLog("Reading branch-specific base branch from agency.json")
		currentBase = await getBaseBranchFromMetadata(gitRoot)

		if (!currentBase) {
			throw new Error(
				`No base branch configured for ${highlight.branch(currentBranch)}. Use 'agency base set <branch>' to set one.`,
			)
		}
	}

	log(currentBase)
}

export async function base(options: BaseOptions): Promise<void> {
	const {
		subcommand,
		args,
		repo = false,
		silent = false,
		verbose = false,
	} = options

	if (!subcommand) {
		throw new Error("Subcommand is required. Usage: agency base <subcommand>")
	}

	switch (subcommand) {
		case "set": {
			if (!args[0]) {
				throw new Error(
					"Base branch argument is required. Usage: agency base set <branch>",
				)
			}
			await baseSet({
				baseBranch: args[0],
				repo,
				silent,
				verbose,
			})
			break
		}
		case "get": {
			await baseGet({
				repo,
				silent,
				verbose,
			})
			break
		}
		default:
			throw new Error(
				`Unknown subcommand '${subcommand}'. Available subcommands: set, get`,
			)
	}
}

export const help = `
Usage: agency base <subcommand> [options]

Get or set the base branch for the current feature branch.

Subcommands:
  set <branch>      Set the base branch for the current feature branch
  get               Get the configured base branch

Options:
  --repo            Use repository-level default instead of branch-specific
  -h, --help        Show this help message
  -s, --silent      Suppress output messages
  -v, --verbose     Show verbose output

Examples:
  agency base set origin/main          # Set base branch for current branch
  agency base set --repo origin/main   # Set repository-level default for all branches
  agency base get                      # Get branch-specific base branch
  agency base get --repo               # Get repository-level default base branch

Notes:
  - The base branch must exist in the repository
  - Branch-specific base branch is saved in agency.json (committed with the branch)
  - Repository-level default is saved in .git/config (not committed)
  - Branch-specific settings take precedence over repository-level defaults
  - Base branch configuration is used by 'agency pr' when creating PR branches
`
