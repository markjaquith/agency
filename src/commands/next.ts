import type { BaseCommandOptions } from "../utils/command"
import { rebase } from "./rebase"

interface NextOptions extends BaseCommandOptions {
	baseBranch?: string
	branch?: string
}

/**
 * The `next` command is a thin wrapper around `rebase --branch`.
 * It rebases onto the base branch and sets a new emit branch name.
 */
export const next = (options: NextOptions = {}) =>
	rebase({
		...options,
		branch: options.branch,
	})

export const help = `
Usage: agency next [base-branch] [options]

Rebase the source branch onto the base branch and optionally set a new emit branch.

This is a convenience wrapper around 'agency rebase --branch'.

Arguments:
  [base-branch]             Optional base branch to rebase onto
                            (defaults to saved base branch or origin/main)

Options:
  -b, --branch <name>       Set a new emit branch name in agency.json after rebasing

Examples:
  agency next                        # Rebase onto saved base branch
  agency next --branch new-feature   # Rebase and set new emit branch name
  agency next origin/main            # Rebase onto origin/main explicitly

Notes:
  - This command only works on agency source branches (with agency.json)
  - If conflicts occur during rebase, you must resolve them manually
`
