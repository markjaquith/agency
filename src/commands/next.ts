import type { BaseCommandOptions } from "../utils/command"
import { rebase } from "./rebase"

interface NextOptions extends BaseCommandOptions {
	baseBranch?: string
	newBranch?: string
}

/**
 * The `next` command is a thin wrapper around `rebase --branch`.
 * It rebases onto the base branch and sets a new emit branch name.
 */
export const next = (options: NextOptions = {}) =>
	rebase({
		...options,
		branch: options.newBranch,
	})

export const help = `
Usage: agency next [new-branch]

Rebase the source branch onto the base branch and set a new emit branch name.

This is a convenience wrapper around 'agency rebase --branch <new-branch>'.

Arguments:
  [new-branch]              New emit branch name to set in agency.json

Examples:
  agency next new-feature   # Rebase and set emit branch to 'new-feature'

Notes:
  - This command only works on agency source branches (with agency.json)
  - The base branch is determined from agency.json or defaults to origin/main
  - If conflicts occur during rebase, you must resolve them manually
`
