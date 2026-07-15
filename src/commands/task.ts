import { Effect } from "effect"
import type { BaseCommandOptions } from "../utils/command"
import { TaskService } from "../services/TaskService"
import { createLoggers } from "../utils/effect"

interface TaskOptions extends BaseCommandOptions {
	readonly subcommand?: string
	readonly args: readonly string[]
	readonly ticketUrl?: string
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
						epic: options.epic,
						multiPhase: options.multiPhase,
						repo: options.repo,
						repos: options.references,
						branch: options.branch,
						base: options.base,
					},
					cwd,
				)
				log(`Created task '${record.id}'`)
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
Usage: agency task <subcommand>

Subcommands:
  create <id>           Create a task
  list                  List tasks
  show <id>             Show a task

Create options:
  --ticket-url <url>    External ticket URL
  --epic <id>           Parent epic
  --repo <alias>        Writable repository
  --reference <alias>   Read-only repository; repeatable
  --branch <name>       Working branch
  --base <name>         Base branch
  --multi-phase         Create a task container for phases

Options:
  --json                Output structured JSON
`
