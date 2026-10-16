import { Effect } from "effect"
import type { BaseCommandOptions } from "../utils/command"
import { ContextService } from "../services/ContextService"
import {
	RuntimeBindingService,
	unitRuntimeView,
} from "../services/RuntimeBindingService"
import { createLoggers } from "../utils/effect"

interface ContextOptions extends BaseCommandOptions {
	readonly target?: string
	readonly compact?: boolean
	readonly full?: boolean
	readonly include?: readonly ("ticket" | "runtime")[]
	readonly json?: boolean
}

const runtimeUnit = (result: {
	readonly workbase: { readonly root: string }
	readonly target: {
		readonly kind: string
		readonly taskId?: string
		readonly phaseId?: string
	}
	readonly authority: {
		readonly mode: string
		readonly writable: { readonly repo: string } | null
	}
	readonly review?: { readonly repo: string } | null
}) => {
	const { target, authority } = result
	const repo = authority.writable?.repo ?? result.review?.repo
	if (authority.mode === "orchestration" || !target.taskId || !repo) return null
	if (target.kind === "phase" && target.phaseId) {
		return {
			id: `execution-unit:phase/${target.taskId}/${target.phaseId}`,
			taskId: target.taskId,
			phaseId: target.phaseId,
			repo,
		}
	}
	if (target.kind === "task") {
		return {
			id: `execution-unit:task/${target.taskId}`,
			taskId: target.taskId,
			repo,
		}
	}
	return null
}

export const context = (options: ContextOptions = {}) =>
	Effect.gen(function* () {
		const service = yield* ContextService
		const { log } = createLoggers(options)
		const result = yield* service.get({
			...options,
			include: options.include?.filter((layer) => layer === "ticket"),
		})
		if (!options.include?.includes("runtime")) {
			log(JSON.stringify(result, null, 2))
			return
		}
		const unit = "authority" in result ? runtimeUnit(result) : null
		if (!unit) {
			log(JSON.stringify({ ...result, runtime: null }, null, 2))
			return
		}
		const inspection = yield* (yield* RuntimeBindingService).inspect(
			result.workbase.root,
			[unit],
		)
		log(
			JSON.stringify(
				{
					...result,
					runtime: {
						provider: inspection.provider,
						available: inspection.available,
						error: inspection.error,
						...unitRuntimeView(inspection, unit.id),
					},
				},
				null,
				2,
			),
		)
	})

export const help = `
Usage: agency context [target] [options]

Return read-only context for a workbase, epic, task, or phase. Compact output is
the default. The target defaults to the current directory and may be the workbase
root, an entity path, or a task ID. Archived entities are inspectable but never
receive mutation or execution authority. Workbase context catalogs all active
epics, tasks, and phases.

Options:
  --json              Output a versioned machine result
  --compact           Use compact output (default)
  --full              Include prose bodies and low-level VCS details
  --include ticket    Include live status of the target's ticketUrl
  --include runtime   Reconcile the execution unit's runtime binding (Herdr)
  --epic <id>         Select an epic
  --task <id>         Select a task
  --phase <id>        Select a phase together with --task
`
