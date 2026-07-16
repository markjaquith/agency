import { Effect } from "effect"
import type { BaseCommandOptions } from "../utils/command"
import { PhaseService } from "../services/PhaseService"
import { createLoggers } from "../utils/effect"
import { parseRepositoryReferences } from "../workbase/repository-reference"

interface PhaseOptions extends BaseCommandOptions {
	readonly subcommand?: string
	readonly args: readonly string[]
	readonly description?: string
	readonly repo?: string
	readonly references?: readonly string[]
	readonly branch?: string
	readonly base?: string
	readonly dependsOn?: readonly string[]
	readonly firstPhase?: string
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
						description: options.description,
						repo: options.repo,
						repos: parseRepositoryReferences(options.references),
						branch: options.branch,
						base: options.base,
						dependsOn: options.dependsOn,
						firstPhase: options.firstPhase,
					},
					cwd,
				)
				const { content: _, ...output } = record
				log(
					options.json
						? JSON.stringify(output, null, 2)
						: `Created phase '${record.id}' on task '${record.taskId}'`,
				)
				return
			}
			case "list": {
				if (!taskId) return yield* Effect.fail(new Error("Task ID is required"))
				const records = yield* phases.list(taskId, cwd)
				if (options.json) {
					log(
						JSON.stringify(
							records.map(({ content: _, ...record }) => record),
							null,
							2,
						),
					)
				} else for (const record of records) log(record.id)
				return
			}
			case "show": {
				if (!taskId || !phaseId) {
					return yield* Effect.fail(
						new Error("Task ID and phase ID are required"),
					)
				}
				const record = yield* phases.show(taskId, phaseId, cwd)
				const { content: _, ...output } = record
				log(
					options.json
						? JSON.stringify(output, null, 2)
						: record.content.trimEnd(),
				)
				return
			}
			case "status": {
				const status = options.args[2]
				if (!taskId || !phaseId || !status) {
					return yield* Effect.fail(
						new Error(
							"Usage: agency phase status <task-id> <phase-id> <status>",
						),
					)
				}
				const record = yield* phases.setStatus(taskId, phaseId, status, cwd)
				const { content: _, ...output } = record
				log(
					options.json
						? JSON.stringify(output, null, 2)
						: `Marked phase '${phaseId}' as ${record.data.status}`,
				)
				return
			}
			default:
				return yield* Effect.fail(
					new Error(
						"Subcommand is required. Available: create, list, show, status",
					),
				)
		}
	})

export const help = `
Usage: agency phase <subcommand> <task-id> [phase-id]

Subcommands:
  create <task> <phase> Create a phase
  list <task>           List task phases
  show <task> <phase>   Show a phase
  status <task> <phase> <status>
                        Set open, working, done, or dropped

Create options:
  --description <text>  Short description of the phase
  --repo <alias>        Writable repository
  --reference <alias>:<ref>
                        Read-only repository reference; repeatable
  --branch <name>       Working branch
  --base <name>         Base branch
  --depends-on <id>     Phase dependency; repeatable
  --first-phase <id>    Existing execution phase ID when converting a task

Options:
  --json                Output results as JSON
`
