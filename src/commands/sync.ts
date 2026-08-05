import { Effect } from "effect"
import { SyncService } from "../services/SyncService"
import type { BaseCommandOptions } from "../utils/command"
import { createLoggers } from "../utils/effect"

interface SyncCommandOptions extends BaseCommandOptions {
	readonly dryRun?: boolean
}

export const sync = (options: SyncCommandOptions = {}) =>
	Effect.gen(function* () {
		const service = yield* SyncService
		const { log } = createLoggers(options)
		const result = yield* service.reconcile({
			cwd: options.cwd,
			apply: options.dryRun !== true,
		})
		if (options.json) return log(JSON.stringify(result, null, 2))

		for (const action of result.repositories.actions) {
			log(
				`${action.status === "applied" ? "Applied" : "Planned"} repository ${action.kind} '${action.alias}' from ${action.remote}`,
			)
		}
		for (const change of result.changes) {
			log(
				`${change.status === "applied" ? "Applied" : "Planned"} ${change.kind} '${change.target}': ${change.message}`,
			)
		}
		for (const warning of result.warnings) {
			log(
				`Warning '${warning.target}': ${warning.message}${warning.action ? `. ${warning.action}` : ""}`,
			)
		}
		for (const issue of result.repositories.unresolved) {
			log(
				`Unresolved repository '${issue.alias}': ${issue.message}. ${issue.action}`,
			)
		}
		for (const issue of result.unresolved) {
			log(
				`Unresolved '${issue.target}': ${issue.message}${issue.action ? `. ${issue.action}` : ""}`,
			)
		}
		if (
			result.repositories.actions.length === 0 &&
			result.changes.length === 0 &&
			result.warnings.length === 0 &&
			result.repositories.unresolved.length === 0 &&
			result.unresolved.length === 0
		) {
			log(
				result.mode === "apply"
					? "Workbase sync is current"
					: "Workbase sync plan is current",
			)
		}
	})

export const help = `
Usage: agency sync [--dry-run] [--json]

Compare portable repository declarations and execution state with local Git
repositories, worktrees, branches, references, claims, and pull requests.
Safe reconciliation transitions are applied by default.

Options:
  --dry-run                 Report planned safe transitions without changing state
  --json                    Output one versioned machine result

Sync may materialize declared repositories and unambiguous missing checkouts,
adopt legacy repositories with portable origins, release expired claims,
record a uniquely matched PR, and mark merged work done. Dirty, stale, or
conflicting checkouts are always left unresolved.
`
