import { Effect } from "effect"
import { ArchiveService } from "../services/ArchiveService"
import type { BaseCommandOptions } from "../utils/command"
import { createLoggers } from "../utils/effect"

interface ArchiveOptions extends BaseCommandOptions {
	readonly type?: string
	readonly args: readonly string[]
	readonly json?: boolean
}

export const archive = (options: ArchiveOptions) =>
	Effect.gen(function* () {
		const archives = yield* ArchiveService
		const { log } = createLoggers(options)
		const cwd = options.cwd ?? process.cwd()
		const [id, phaseId] = options.args

		let result
		switch (options.type) {
			case "epic":
				if (!id) {
					return yield* Effect.fail(
						new Error("Usage: agency archive epic <epic-id>"),
					)
				}
				result = yield* archives.archiveEpic(id, cwd)
				break
			case "task":
				if (!id) {
					return yield* Effect.fail(
						new Error("Usage: agency archive task <task-id>"),
					)
				}
				result = yield* archives.archiveTask(id, cwd)
				break
			case "phase":
				if (!id || !phaseId) {
					return yield* Effect.fail(
						new Error("Usage: agency archive phase <task-id> <phase-id>"),
					)
				}
				result = yield* archives.archivePhase(id, phaseId, cwd)
				break
			default:
				return yield* Effect.fail(
					new Error("Work item type is required. Available: epic, task, phase"),
				)
		}

		log(
			options.json
				? JSON.stringify(result, null, 2)
				: `Archived ${result.kind} '${result.id}' to ${result.path}`,
		)
	})

export const help = `
Usage: agency archive <type> <id>

Archive a work item after removing its worktrees. Branches are preserved.

Types:
  epic <epic-id>                Archive an epic and its tasks
  task <task-id>                Archive a task
  phase <task-id> <phase-id>    Archive a phase

Options:
  --json                        Output results as JSON
`
