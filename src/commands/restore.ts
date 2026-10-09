import { Effect } from "effect"
import { ArchiveService } from "../services/ArchiveService"
import type { BaseCommandOptions } from "../utils/command"
import { createLoggers } from "../utils/effect"
import {
	resolveEpicSelector,
	resolvePhaseSelector,
	resolveTaskSelector,
} from "../workbase/item-selector"

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
		const archived = { archived: true }
		let result
		switch (options.type) {
			case "epic": {
				const target = yield* resolveEpicSelector(id, cwd, archived)
				result = yield* archives.restoreEpic(target.epicId, target.root, {
					dryRun: options.dryRun,
				})
				break
			}
			case "task": {
				const target = yield* resolveTaskSelector(id, cwd, archived)
				result = yield* archives.restoreTask(target.taskId, target.root, {
					dryRun: options.dryRun,
				})
				break
			}
			case "phase": {
				const target = yield* resolvePhaseSelector(id, phaseId, cwd, archived)
				result = yield* archives.restorePhase(
					target.taskId,
					target.phaseId,
					target.root,
					{ dryRun: options.dryRun },
				)
				break
			}
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
  epic [epic]                            Restore an epic and its tasks
  task [task]                            Restore a task
  phase [<phase> | <task> <phase-id>]    Restore a phase

Selectors accept an ID or a path to the archived item's document or directory
and default to the archived item containing the current directory.

Options:
  --dry-run                              Preflight without changing files
  --json                                 Output results as JSON
`
