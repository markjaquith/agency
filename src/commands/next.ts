import { Effect } from "effect"
import { ReadinessService } from "../services/ReadinessService"
import type { BaseCommandOptions } from "../utils/command"
import { createLoggers } from "../utils/effect"

interface NextOptions extends BaseCommandOptions {
	readonly select?: boolean
}

const context = (item: {
	readonly parent: { readonly taskId?: string; readonly epicId?: string }
}) =>
	[
		item.parent.epicId ? `epic ${item.parent.epicId}` : undefined,
		item.parent.taskId ? `task ${item.parent.taskId}` : undefined,
	]
		.filter(Boolean)
		.join(" / ")

export const next = (options: NextOptions = {}) =>
	Effect.gen(function* () {
		const readiness = yield* ReadinessService
		const { log } = createLoggers(options)
		const result = yield* readiness.getNext(
			options.cwd ?? process.cwd(),
			options.select,
		)
		if (options.json) {
			log(JSON.stringify(result, null, 2))
			return
		}
		if (options.select) {
			if (!result.selected) {
				log("No execution units are ready.")
				return
			}
			const parent = context(result.selected)
			log(
				`${result.selected.key}${parent ? ` (${parent})` : ""} - priority ${result.selected.priority.dependentCount}`,
			)
			return
		}
		if (result.ready.length === 0) {
			log("No execution units are ready.")
			return
		}
		for (const item of result.ready) {
			const parent = context(item)
			log(
				`${item.rank}. ${item.key}${parent ? ` (${parent})` : ""} - priority ${item.priority.dependentCount}`,
			)
		}
	})

export const help = `
Usage: agency next [--select] [--json]

List ready execution units in priority order or select the highest-priority unit.
Structured output also includes excluded units and their blockers.

Options:
  --select            Return only the highest-priority ready unit in human output
  --json              Output ready and excluded execution units as JSON
`
