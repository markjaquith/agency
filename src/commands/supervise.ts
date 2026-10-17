import { Effect } from "effect"
import type { BaseCommandOptions } from "../utils/command"
import { act } from "./act"

interface SuperviseOptions extends BaseCommandOptions {
	/** Supervise only this registered workbase. */
	readonly workbase?: string
}

/** `agency supervise` opens the Agency TUI on its Supervise tab. */
export const supervise = (options: SuperviseOptions = {}) =>
	options.inputAllowed === false
		? Effect.fail(
				new Error(
					"agency supervise requires an interactive terminal; use agency attention --json for automation",
				),
			)
		: act({
				cwd: options.cwd,
				inputAllowed: options.inputAllowed,
				silent: options.silent,
				verbose: options.verbose,
				tab: "supervise",
				supervise: { workbase: options.workbase },
			})

export const help = `
Usage: agency supervise [--workbase <selector>]

Open the Agency TUI (agency act) on its Supervise tab: everything needing
attention across every registered workbase, grouped by workbase plus an
Unmanaged group, with a selected action run by Enter. It refreshes on runtime
(Herdr) events and periodically for pull request and ticket changes. Tab and
Shift-Tab switch to Workstream and Workbase, which follow the selected item's
workbase.

Every action previews exactly what it runs, rechecks its preconditions against
fresh state, and is appended to the local action log. Destructive actions need
a second confirmation. Agency actions collect their inputs in the act wizard,
then are re-resolved through agency act before running; work launches in a
new, unfocused tab. Snoozes and dismissals persist in local supervision state.
Triage results merge into the view; r triages the selected item and R
everything. Press ? for keys.

Options:
  --workbase <selector>  Supervise only one registered workbase
`
