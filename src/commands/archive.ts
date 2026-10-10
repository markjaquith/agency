import { Effect } from "effect"
import { ArchiveService } from "../services/ArchiveService"
import type { BaseCommandOptions } from "../utils/command"
import { createLoggers } from "../utils/effect"
import {
	resolveEpicSelector,
	resolvePhaseSelector,
	resolveTaskSelector,
} from "../workbase/item-selector"

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
		let archiveType = options.type
		let archiveId: string | undefined
		let archiveTaskId: string | undefined
		let root = cwd

		if (!archiveType) {
			const target = yield* archives.resolvePathTarget(id ?? ".", cwd)
			archiveType = target.kind
			archiveId = target.id
			archiveTaskId = target.taskId
		}

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
			if (!kind || (kind !== "phase" && secondId !== undefined)) {
				return yield* Effect.fail(
					new Error(
						"Usage: agency archive show <epic|task> [id-or-path] | phase [<phase> | <task> <phase-id>]",
					),
				)
			}
			const archived = { archived: true }
			let target: { root: string; id: string; taskId?: string }
			if (kind === "epic") {
				const epic = yield* resolveEpicSelector(firstId, cwd, archived)
				target = { root: epic.root, id: epic.epicId }
			} else if (kind === "task") {
				const task = yield* resolveTaskSelector(firstId, cwd, archived)
				target = { root: task.root, id: task.taskId }
			} else {
				const phase = yield* resolvePhaseSelector(
					firstId,
					secondId,
					cwd,
					archived,
				)
				target = { root: phase.root, id: phase.phaseId, taskId: phase.taskId }
			}
			const record = yield* archives.show(
				kind,
				target.id,
				target.taskId,
				target.root,
			)
			log(options.json ? JSON.stringify(record, null, 2) : record.content)
			return
		}

		if (options.type === "epic") {
			const target = yield* resolveEpicSelector(id, cwd)
			root = target.root
			archiveId = target.epicId
		} else if (options.type === "task") {
			const target = yield* resolveTaskSelector(id, cwd)
			root = target.root
			archiveId = target.taskId
		} else if (options.type === "phase") {
			const target = yield* resolvePhaseSelector(id, phaseId, cwd)
			root = target.root
			archiveTaskId = target.taskId
			archiveId = target.phaseId
		}

		let result
		switch (archiveType) {
			case "epic":
				result = yield* archives.archiveEpic(archiveId!, root, {
					dryRun: options.dryRun,
				})
				break
			case "task":
				result = yield* archives.archiveTask(archiveId!, root, {
					dryRun: options.dryRun,
				})
				break
			case "tasks":
				result = yield* archives.archiveTasks(cwd, {
					dryRun: options.dryRun,
				})
				break
			case "phase":
				result = yield* archives.archivePhase(
					archiveTaskId!,
					archiveId!,
					root,
					{
						dryRun: options.dryRun,
					},
				)
				break
			default:
				return yield* Effect.fail(
					new Error(
						"Archive target is required. Provide a path or use: list, show, epic, task, tasks, phase",
					),
				)
		}

		if (result.kind === "tasks") {
			const selected = result.tasks.filter(
				(task) => task.disposition !== "skipped",
			)
			const skipped = result.tasks.filter(
				(task) => task.disposition === "skipped",
			)
			log(
				options.json
					? JSON.stringify(result, null, 2)
					: [
							`${result.dryRun ? "Would archive" : "Archived"} ${selected.length} task${selected.length === 1 ? "" : "s"}${selected.length ? `: ${selected.map((task) => task.id).join(", ")}` : ""}`,
							`Skipped ${skipped.length} task${skipped.length === 1 ? "" : "s"}${skipped.length ? `: ${skipped.map((task) => `${task.id} (${task.reason!.code})`).join(", ")}` : ""}`,
						].join("\n"),
			)
			return
		}
		log(
			options.json
				? JSON.stringify(result, null, 2)
				: result.dryRun
					? `Would archive ${result.kind} '${result.id}' to ${result.path}`
					: `Archived ${result.kind} '${result.id}' to ${result.path}`,
		)
	})

export const help = `
Usage: agency archive [path|list|show|epic|task|tasks|phase]

Browse or archive work items after preflighting worktrees and graph references.

With no target, the current epic, task, or phase is inferred. An existing path
within one of those items infers it too.

Commands:
  [path]                                 Archive the containing epic, task, or phase
  list [filters]                         List archived work
  show <epic|task> [id-or-path]          Show an archived epic or task
  show phase [<phase> | <task> <phase-id>]
                                         Show an archived phase
  epic [epic]                            Archive an epic and its tasks
  task [task]                            Archive a task
  tasks                                  Archive all eligible terminal tasks
  phase [<phase> | <task> <phase-id>]    Archive a phase

Item selectors accept an ID or a path to the item's document or directory and
default to the item containing the current directory. Show selectors refer to
archived items.

Options:
  --kind <kind>                          Filter list by kind (repeatable)
  --status <status>                      Filter list by status (repeatable)
  --repository <alias>                   Filter list by repository (repeatable)
  --dry-run                              Preflight without changing files
  --json                                 Output results as JSON
`
