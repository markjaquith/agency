import { Effect } from "effect"
import type { BaseCommandOptions } from "../utils/command"
import { PhaseService } from "../services/PhaseService"
import { createLoggers } from "../utils/effect"

interface PhaseOptions extends BaseCommandOptions {
	readonly subcommand?: string
	readonly args: readonly string[]
	readonly repo?: string
	readonly references?: readonly string[]
	readonly branch?: string
	readonly base?: string
	readonly dependsOn?: readonly string[]
	readonly json?: boolean
}

export const phase = (options: PhaseOptions) =>
	Effect.gen(function* () {
		const phases = yield* PhaseService
		const { log } = createLoggers(options)
		const cwd = options.cwd ?? process.cwd()
		const [taskId, phaseId] = options.args

		switch (options.subcommand) {
			case "create": {
				if (
					!taskId ||
					!phaseId ||
					!options.repo ||
					!options.branch ||
					!options.base
				) {
					return yield* Effect.fail(
						new Error(
							"Usage: agency phase create <task-id> <phase-id> --repo <alias> --branch <name> --base <name>",
						),
					)
				}
				const record = yield* phases.create(
					{
						taskId,
						id: phaseId,
						repo: options.repo,
						repos: options.references,
						branch: options.branch,
						base: options.base,
						dependsOn: options.dependsOn,
					},
					cwd,
				)
				log(`Created phase '${record.id}' on task '${record.taskId}'`)
				return
			}
			case "list": {
				if (!taskId) return yield* Effect.fail(new Error("Task ID is required"))
				const records = yield* phases.list(taskId, cwd)
				if (options.json) log(JSON.stringify(records, null, 2))
				else for (const record of records) log(record.id)
				return
			}
			case "show": {
				if (!taskId || !phaseId) {
					return yield* Effect.fail(
						new Error("Task ID and phase ID are required"),
					)
				}
				const record = yield* phases.show(taskId, phaseId, cwd)
				log(
					options.json
						? JSON.stringify(record.data, null, 2)
						: record.content.trimEnd(),
				)
				return
			}
			default:
				return yield* Effect.fail(
					new Error("Subcommand is required. Available: create, list, show"),
				)
		}
	})

export const help = `
Usage: agency phase <subcommand> <task-id> [phase-id]

Subcommands:
  create <task> <phase> Create a phase
  list <task>           List task phases
  show <task> <phase>   Show a phase

Create options:
  --repo <alias>        Writable repository
  --reference <alias>   Read-only repository; repeatable
  --branch <name>       Working branch
  --base <name>         Base branch
  --depends-on <id>     Phase dependency; repeatable

Options:
  --json                Output structured JSON
`
