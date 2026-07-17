import { Effect } from "effect"
import { ArchiveService } from "../services/ArchiveService"
import type { BaseCommandOptions } from "../utils/command"
import { createLoggers } from "../utils/effect"

interface ArchiveOptions extends BaseCommandOptions {
	readonly type?: string
	readonly args: readonly string[]
	readonly json?: boolean
	readonly dryRun?: boolean
	readonly kinds?: readonly string[]
	readonly statuses?: readonly string[]
	readonly repositories?: readonly string[]
}

const archiveKind = (value: string | undefined) => {
	if (value === "epic" || value === "task" || value === "phase") return value
	return undefined
}

export const archive = (options: ArchiveOptions) =>
	Effect.gen(function* () {
		const archives = yield* ArchiveService
		const { log } = createLoggers(options)
		const cwd = options.cwd ?? process.cwd()
		const [id, phaseId] = options.args

		if (options.type === "list") {
			const records = yield* archives.list(
				{
					kinds: options.kinds,
					statuses: options.statuses,
					repositories: options.repositories,
				},
				cwd,
			)
			log(
				options.json
					? JSON.stringify(records, null, 2)
					: records
							.map((record) =>
								record.kind === "phase"
									? `phase\t${record.taskId}/${record.id}`
									: `${record.kind}\t${record.id}`,
							)
							.join("\n"),
			)
			return
		}

		if (options.type === "show") {
			const [kindValue, firstId, secondId] = options.args
			const kind = archiveKind(kindValue)
			if (
				!kind ||
				!firstId ||
				(kind === "phase" ? !secondId : secondId !== undefined)
			) {
				return yield* Effect.fail(
					new Error(
						"Usage: agency archive show <epic|task> <id> | phase <task-id> <phase-id>",
					),
				)
			}
			const record = yield* archives.show(
				kind,
				kind === "phase" ? secondId! : firstId,
				kind === "phase" ? firstId : undefined,
				cwd,
			)
			log(options.json ? JSON.stringify(record, null, 2) : record.content)
			return
		}

		let result
		switch (options.type) {
			case "epic":
				if (!id)
					return yield* Effect.fail(
						new Error("Usage: agency archive epic <epic-id>"),
					)
				result = yield* archives.archiveEpic(id, cwd, {
					dryRun: options.dryRun,
				})
				break
			case "task":
				if (!id)
					return yield* Effect.fail(
						new Error("Usage: agency archive task <task-id>"),
					)
				result = yield* archives.archiveTask(id, cwd, {
					dryRun: options.dryRun,
				})
				break
			case "phase":
				if (!id || !phaseId)
					return yield* Effect.fail(
						new Error("Usage: agency archive phase <task-id> <phase-id>"),
					)
				result = yield* archives.archivePhase(id, phaseId, cwd, {
					dryRun: options.dryRun,
				})
				break
			default:
				return yield* Effect.fail(
					new Error(
						"Archive operation is required. Available: list, show, epic, task, phase",
					),
				)
		}

		log(
			options.json
				? JSON.stringify(result, null, 2)
				: `${result.dryRun ? "Would archive" : "Archived"} ${result.kind} '${result.id}' to ${result.path}`,
		)
	})

export const help = `
Usage: agency archive <list|show|epic|task|phase>

Browse or archive work items after preflighting worktrees and graph references.

Commands:
  list [filters]                         List archived work
  show <type> <id>                       Show an archived epic or task
  show phase <task-id> <phase-id>        Show an archived phase
  epic <epic-id>                         Archive an epic and its tasks
  task <task-id>                         Archive a task
  phase <task-id> <phase-id>             Archive a phase

Options:
  --kind <kind>                          Filter list by kind (repeatable)
  --status <status>                      Filter list by status (repeatable)
  --repository <alias>                   Filter list by repository (repeatable)
  --dry-run                              Preflight without changing files
  --json                                 Output results as JSON
`
