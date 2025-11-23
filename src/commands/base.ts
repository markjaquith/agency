import { Effect } from "effect"
import { GitService } from "../services/GitService"
import { ConfigService } from "../services/ConfigService"
import { setBaseBranchInMetadata, getBaseBranchFromMetadata } from "../types"
import highlight, { done } from "../utils/colors"
import { createLoggers, ensureGitRepo } from "../utils/effect"

interface BaseOptions {
	subcommand?: string
	args: string[]
	repo?: boolean
	silent?: boolean
	verbose?: boolean
}

interface BaseSetOptions {
	baseBranch: string
	repo?: boolean
	silent?: boolean
	verbose?: boolean
}

interface BaseGetOptions {
	repo?: boolean
	silent?: boolean
	verbose?: boolean
}

// Effect-based implementation
const baseSetEffect = (options: BaseSetOptions) =>
	Effect.gen(function* () {
		const { baseBranch, repo = false } = options
		const { log, verboseLog } = createLoggers(options)

		const git = yield* GitService
		const gitRoot = yield* ensureGitRepo()

		// Validate that the base branch exists
		const exists = yield* git.branchExists(gitRoot, baseBranch)
		if (!exists) {
			return yield* Effect.fail(
				new Error(
					`Base branch ${highlight.branch(baseBranch)} does not exist. Please provide a valid branch name.`,
				),
			)
		}

		if (repo) {
			// Set repository-level default base branch in git config
			yield* git.setDefaultBaseBranchConfig(baseBranch, gitRoot)
			log(
				done(
					`Set repository-level default base branch to ${highlight.branch(baseBranch)}`,
				),
			)
		} else {
			// Set branch-specific base branch in agency.json
			const currentBranch = yield* git.getCurrentBranch(gitRoot)
			verboseLog(`Current branch: ${highlight.branch(currentBranch)}`)

			// Use Effect.tryPromise for metadata functions
			yield* Effect.tryPromise({
				try: () => setBaseBranchInMetadata(gitRoot, baseBranch),
				catch: (error) =>
					new Error(`Failed to set base branch in metadata: ${error}`),
			})
			log(
				done(
					`Set base branch to ${highlight.branch(baseBranch)} for ${highlight.branch(currentBranch)}`,
				),
			)
		}
	})

// Effect-based implementation
const baseGetEffect = (options: BaseGetOptions) =>
	Effect.gen(function* () {
		const { repo = false } = options
		const { log, verboseLog } = createLoggers(options)

		const git = yield* GitService
		const gitRoot = yield* ensureGitRepo()

		let currentBase: string | null

		if (repo) {
			// Get repository-level default base branch from git config
			verboseLog("Reading repository-level default base branch from git config")
			currentBase = yield* git.getDefaultBaseBranchConfig(gitRoot)

			if (!currentBase) {
				return yield* Effect.fail(
					new Error(
						"No repository-level base branch configured. Use 'agency base set --repo <branch>' to set one.",
					),
				)
			}
		} else {
			// Get current branch
			const currentBranch = yield* git.getCurrentBranch(gitRoot)
			verboseLog(`Current branch: ${highlight.branch(currentBranch)}`)

			// Get branch-specific base branch from agency.json
			verboseLog("Reading branch-specific base branch from agency.json")
			currentBase = yield* Effect.tryPromise({
				try: () => getBaseBranchFromMetadata(gitRoot),
				catch: (error) => {
					throw new Error(`Failed to get base branch from metadata: ${error}`)
				},
			})

			if (!currentBase) {
				return yield* Effect.fail(
					new Error(
						`No base branch configured for ${highlight.branch(currentBranch)}. Use 'agency base set <branch>' to set one.`,
					),
				)
			}
		}

		log(currentBase)
	})

// Effect-based implementation
const baseEffect = (options: BaseOptions) =>
	Effect.gen(function* () {
		const {
			subcommand,
			args,
			repo = false,
			silent = false,
			verbose = false,
		} = options

		if (!subcommand) {
			return yield* Effect.fail(
				new Error("Subcommand is required. Usage: agency base <subcommand>"),
			)
		}

		switch (subcommand) {
			case "set": {
				if (!args[0]) {
					return yield* Effect.fail(
						new Error(
							"Base branch argument is required. Usage: agency base set <branch>",
						),
					)
				}
				return yield* baseSetEffect({
					baseBranch: args[0],
					repo,
					silent,
					verbose,
				})
			}
			case "get": {
				return yield* baseGetEffect({
					repo,
					silent,
					verbose,
				})
			}
			default:
				return yield* Effect.fail(
					new Error(
						`Unknown subcommand '${subcommand}'. Available subcommands: set, get`,
					),
				)
		}
	})

// Backward-compatible Promise wrappers
export async function baseSet(options: BaseSetOptions): Promise<void> {
	const { GitServiceLive } = await import("../services/GitServiceLive")

	const program = baseSetEffect(options).pipe(
		Effect.provide(GitServiceLive),
		Effect.catchAllDefect((defect) =>
			Effect.fail(defect instanceof Error ? defect : new Error(String(defect))),
		),
	)

	await Effect.runPromise(program)
}

export async function baseGet(options: BaseGetOptions): Promise<void> {
	const { GitServiceLive } = await import("../services/GitServiceLive")

	const program = baseGetEffect(options).pipe(
		Effect.provide(GitServiceLive),
		Effect.catchAllDefect((defect) =>
			Effect.fail(defect instanceof Error ? defect : new Error(String(defect))),
		),
	)

	await Effect.runPromise(program)
}

export async function base(options: BaseOptions): Promise<void> {
	const { GitServiceLive } = await import("../services/GitServiceLive")

	const program = baseEffect(options).pipe(
		Effect.provide(GitServiceLive),
		Effect.catchAllDefect((defect) =>
			Effect.fail(defect instanceof Error ? defect : new Error(String(defect))),
		),
	)

	await Effect.runPromise(program)
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
