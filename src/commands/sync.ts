import { Effect } from "effect"
import { SyncService } from "../services/SyncService"
import type { BaseCommandOptions } from "../utils/command"
import { createLoggers } from "../utils/effect"

interface SyncCommandOptions extends BaseCommandOptions {
	readonly apply?: boolean
	readonly dryRun?: boolean
}

export const sync = (options: SyncCommandOptions = {}) =>
	Effect.gen(function* () {
		const service = yield* SyncService
		const { log } = createLoggers(options)
		const result = yield* service.reconcile({
			cwd: options.cwd,
			apply: options.apply === true,
		})
		log(JSON.stringify(result, null, 2))
	})

export const help = `
Usage: agency sync [--dry-run | --apply] [--json]

Compare portable repository declarations and execution state with local Git
repositories, worktrees, branches, references, claims, and pull requests.
Dry-run is the default.

Options:
  --dry-run                 Report planned safe transitions without changing state
  --apply                   Apply safe reconciliation transitions
  --json                    Output one versioned machine result

Apply may materialize declared repositories and unambiguous missing checkouts,
adopt legacy repositories with portable origins, release expired claims,
record a uniquely matched PR, and mark merged work done. Dirty, stale, or
conflicting checkouts are always left unresolved.
`
