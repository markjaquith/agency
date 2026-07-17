import { Effect } from "effect"
import { ArchiveService } from "../services/ArchiveService"
import type { BaseCommandOptions } from "../utils/command"
import { createLoggers } from "../utils/effect"

interface RestoreOptions extends BaseCommandOptions {
	readonly type?: string
	readonly args: readonly string[]
	readonly json?: boolean
	readonly dryRun?: boolean
}

export const restore = (options: RestoreOptions) =>
	Effect.gen(function* () {
		const archives = yield* ArchiveService
		const { log } = createLoggers(options)
		const cwd = options.cwd ?? process.cwd()
		const [id, phaseId] = options.args
		let result
		switch (options.type) {
			case "epic":
				if (!id)
					return yield* Effect.fail(
						new Error("Usage: agency restore epic <epic-id>"),
					)
				result = yield* archives.restoreEpic(id, cwd, {
					dryRun: options.dryRun,
				})
				break
			case "task":
				if (!id)
					return yield* Effect.fail(
						new Error("Usage: agency restore task <task-id>"),
					)
				result = yield* archives.restoreTask(id, cwd, {
					dryRun: options.dryRun,
				})
				break
			case "phase":
				if (!id || !phaseId)
					return yield* Effect.fail(
						new Error("Usage: agency restore phase <task-id> <phase-id>"),
					)
				result = yield* archives.restorePhase(id, phaseId, cwd, {
					dryRun: options.dryRun,
				})
				break
			default:
				return yield* Effect.fail(
					new Error("Work item type is required. Available: epic, task, phase"),
				)
		}
		log(
			options.json
				? JSON.stringify(result, null, 2)
				: `${result.dryRun ? "Would restore" : "Restored"} ${result.kind} '${result.id}' to ${result.path}`,
		)
	})

export const help = `
Usage: agency restore <epic|task|phase>

Restore archived work after preflighting IDs, backlinks, dependencies, and paths.

Commands:
  epic <epic-id>                         Restore an epic and its tasks
  task <task-id>                         Restore a task
  phase <task-id> <phase-id>             Restore a phase

Options:
  --dry-run                              Preflight without changing files
  --json                                 Output results as JSON
`
