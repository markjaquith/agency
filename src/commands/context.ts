import { Effect } from "effect"
import type { BaseCommandOptions } from "../utils/command"
import { ContextService } from "../services/ContextService"
import { createLoggers } from "../utils/effect"

interface ContextOptions extends BaseCommandOptions {
	readonly target?: string
	readonly compact?: boolean
	readonly full?: boolean
	readonly json?: boolean
}

export const context = (options: ContextOptions = {}) =>
	Effect.gen(function* () {
		const service = yield* ContextService
		const { log } = createLoggers(options)
		const result = yield* service.get(options)
		log(JSON.stringify(result, null, 2))
	})

export const help = `
Usage: agency context [target] [options]

Return complete, read-only context for a workbase, epic, task, or phase. The
target defaults to the current directory and may be the workbase root, an entity
path, or a task ID. Workbase context catalogs all epics, tasks, and phases.

Options:
  --json              Output a versioned machine result
  --compact           Omit prose bodies and low-level Git details
  --full              Include prose bodies in root workbase context
  --epic <id>         Select an epic
  --task <id>         Select a task
  --phase <id>        Select a phase together with --task
`
