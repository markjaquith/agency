import { Effect } from "effect"
import { resolve, relative } from "path"
import type { BaseCommandOptions } from "../utils/command"
import { GitService } from "../services/GitService"
import { AGENCY_WORKTREES_DIR } from "../constants"
import highlight, { info } from "../utils/colors"
import { createLoggers, ensureGitRepo } from "../utils/effect"

interface WorktreeListOptions extends BaseCommandOptions {}

/**
 * List all agency worktrees for the current repository.
 * Filters to only show worktrees inside .agency-worktrees/.
 */
export const worktreeList = (options: WorktreeListOptions = {}) =>
	Effect.gen(function* () {
		const { log, verboseLog } = createLoggers(options)
		const git = yield* GitService

		const gitRoot = yield* ensureGitRepo()
		const mainRepoRoot = yield* git.getMainRepoRoot(gitRoot)
		const worktreesDir = resolve(mainRepoRoot, AGENCY_WORKTREES_DIR)

		verboseLog(`Main repo root: ${mainRepoRoot}`)
		verboseLog(`Worktrees dir: ${worktreesDir}`)

		const allWorktrees = yield* git.listWorktrees(gitRoot)

		// Filter to only agency worktrees (those inside .agency-worktrees/)
		const agencyWorktrees = allWorktrees.filter((wt) =>
			wt.path.startsWith(worktreesDir),
		)

		if (agencyWorktrees.length === 0) {
			log(info("No agency worktrees found"))
			log(info(`Create one with: agency task --worktree <branch-name>`))
			return
		}

		for (const wt of agencyWorktrees) {
			const relativePath = relative(mainRepoRoot, wt.path)
			const branchDisplay = wt.branch
				? highlight.branch(wt.branch)
				: wt.detached
					? "detached"
					: "unknown"
			log(`${branchDisplay}  ${relativePath}`)
		}
	})

export const help = `
Usage: agency worktree list

List all agency worktrees for the current repository.
Shows worktrees created with 'agency task --worktree'.

Example:
  agency worktree list
`
