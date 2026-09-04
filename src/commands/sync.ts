import { Effect } from "effect"
import { SyncService } from "../services/SyncService"
import type { BaseCommandOptions } from "../utils/command"
import { createLoggers } from "../utils/effect"
import { createProgress, type Progress } from "../utils/progress"

interface SyncCommandOptions extends BaseCommandOptions {
	readonly dryRun?: boolean
	readonly taskId?: string
	readonly phaseId?: string
}

interface Notice {
	readonly kind: string
	readonly target: string
	readonly message: string
	readonly action?: string
}

const groupedNotices = <T extends Notice>(notices: readonly T[]) => {
	const groups = new Map<string, { notice: T; targets: string[] }>()
	for (const notice of notices) {
		const key = JSON.stringify([notice.kind, notice.message, notice.action])
		const group = groups.get(key)
		if (group) group.targets.push(notice.target)
		else groups.set(key, { notice, targets: [notice.target] })
	}
	return groups.values()
}

const formatTargets = (targets: readonly string[]) =>
	targets.map((target) => `'${target}'`).join(", ")

export const sync = (
	options: SyncCommandOptions = {},
	progress: Progress = createProgress({
		silent: options.silent || options.json,
	}),
) =>
	Effect.gen(function* () {
		const service = yield* SyncService
		const { log } = createLoggers(options)
		const showProgress = !options.silent && !options.json
		if (showProgress) progress.start("Validating workbase")
		const result = yield* service
			.reconcile({
				cwd: options.cwd,
				apply: options.dryRun !== true,
				taskId: options.taskId,
				phaseId: options.phaseId,
				onProgress: showProgress
					? ({ stage, current, total, target }) => {
							if (stage === "repositories") {
								progress.start(`Inspected ${total} repositories`)
							} else if (stage === "pull-requests") {
								progress.start(
									`Queried pull requests ${current}/${total}${target ? ` (${target})` : ""}`,
								)
							} else {
								progress.start(
									`Reconciled execution units ${current}/${total}${target ? ` (${target})` : ""}`,
								)
							}
						}
					: undefined,
			})
			.pipe(
				Effect.tapError(() =>
					Effect.sync(() => {
						if (showProgress) progress.fail("Workbase sync failed")
					}),
				),
			)
		if (showProgress)
			progress.succeed(
				`Synchronized ${result.executions.length} execution units`,
			)
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
		for (const { notice: warning, targets } of groupedNotices(
			result.warnings,
		)) {
			log(
				`Warning ${formatTargets(targets)}: ${warning.message}${warning.action ? `. ${warning.action}` : ""}`,
			)
		}
		for (const issue of result.repositories.unresolved) {
			log(
				`Unresolved repository '${issue.alias}': ${issue.message}. ${issue.action}`,
			)
		}
		for (const { notice: issue, targets } of groupedNotices(
			result.unresolved,
		)) {
			log(
				`Unresolved ${formatTargets(targets)}: ${issue.message}${issue.action ? `. ${issue.action}` : ""}`,
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
Usage: agency sync [<task-id> [phase-id]] [--dry-run] [--json]

Compare portable repository declarations and execution state with local Git
repositories, worktrees, branches, references, and pull requests.
Safe reconciliation transitions are applied by default.
When a task or phase is provided, only that target and its repositories are
queried or reconciled. Task scope includes all phases of a multi-phase task.

Options:
  --dry-run                 Report planned safe transitions without changing state
  --json                    Output one versioned machine result

Sync may materialize declared repositories and unambiguous missing checkouts,
adopt legacy repositories with portable origins, record a uniquely matched PR,
and mark merged work done. Dirty, stale, or
conflicting checkouts are always left unresolved.
`
