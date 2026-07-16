import { Effect } from "effect"
import type { BaseCommandOptions } from "../utils/command"
import { TaskService } from "../services/TaskService"
import { createLoggers } from "../utils/effect"
import { parseRepositoryReferences } from "../workbase/repository-reference"

interface TaskOptions extends BaseCommandOptions {
	readonly subcommand?: string
	readonly args: readonly string[]
	readonly ticketUrl?: string
	readonly description?: string
	readonly epic?: string
	readonly repo?: string
	readonly references?: readonly string[]
	readonly branch?: string
	readonly base?: string
	readonly multiPhase?: boolean
	readonly json?: boolean
}

export const task = (options: TaskOptions) =>
	Effect.gen(function* () {
		const tasks = yield* TaskService
		const { log } = createLoggers(options)
		const cwd = options.cwd ?? process.cwd()

		switch (options.subcommand) {
			case "create": {
				const id = options.args[0]
				if (!id || !options.ticketUrl) {
					return yield* Effect.fail(
						new Error("Usage: agency task create <id> --ticket-url <url>"),
					)
				}
				const record = yield* tasks.create(
					{
						id,
						ticketUrl: options.ticketUrl,
						description: options.description,
						epic: options.epic,
						multiPhase: options.multiPhase,
						repo: options.repo,
						repos: parseRepositoryReferences(options.references),
						branch: options.branch,
						base: options.base,
					},
					cwd,
				)
				const { content: _, ...output } = record
				log(
					options.json
						? JSON.stringify(output, null, 2)
						: `Created task '${record.id}'`,
				)
				return
			}
			case "list": {
				const records = yield* tasks.list(cwd)
				if (options.json) {
					log(
						JSON.stringify(
							records.map(({ content: _, ...record }) => record),
							null,
							2,
						),
					)
				} else {
					for (const record of records) log(record.id)
				}
				return
			}
			case "show": {
				const id = options.args[0]
				if (!id) return yield* Effect.fail(new Error("Task ID is required"))
				const record = yield* tasks.show(id, cwd)
				const { content: _, ...output } = record
				log(
					options.json
						? JSON.stringify(output, null, 2)
						: record.content.trimEnd(),
				)
				return
			}
			case "status": {
				const [id, status] = options.args
				if (!id || !status) {
					return yield* Effect.fail(
						new Error("Usage: agency task status <id> <status>"),
					)
				}
				const record = yield* tasks.setStatus(id, status, cwd)
				const { content: _, ...output } = record
				log(
					options.json
						? JSON.stringify(output, null, 2)
						: `Marked task '${id}' as ${record.data.status}`,
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
Usage: agency task <subcommand>

Subcommands:
  create <id>           Create a task
  list                  List tasks
  show <id>             Show a task
  status <id> <status>  Set open, working, done, or dropped

Create options:
  --ticket-url <url>    External ticket URL
  --description <text>  Short description of the task
  --epic <id>           Parent epic
  --repo <alias>        Writable repository
  --reference <alias>:<ref>
                        Read-only repository reference; repeatable
  --branch <name>       Working branch
  --base <name>         Base branch
  --multi-phase         Create a task container for phases

Options:
  --json                Output results as JSON
`
