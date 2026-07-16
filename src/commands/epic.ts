import { Effect } from "effect"
import type { BaseCommandOptions } from "../utils/command"
import { EpicService } from "../services/EpicService"
import { createLoggers } from "../utils/effect"
import { parseRepositoryReferences } from "../workbase/repository-reference"

interface EpicOptions extends BaseCommandOptions {
	readonly subcommand?: string
	readonly args: readonly string[]
	readonly ticketUrl?: string
	readonly description?: string
	readonly repos?: readonly string[]
	readonly json?: boolean
}

export const epic = (options: EpicOptions) =>
	Effect.gen(function* () {
		const epics = yield* EpicService
		const { log } = createLoggers(options)
		const cwd = options.cwd ?? process.cwd()

		switch (options.subcommand) {
			case "create": {
				const id = options.args[0]
				if (!id || !options.ticketUrl || !options.repos?.length) {
					return yield* Effect.fail(
						new Error(
							"Usage: agency epic create <id> --ticket-url <url> --repo <alias>:<ref>",
						),
					)
				}
				const record = yield* epics.create(
					id,
					options.ticketUrl,
					parseRepositoryReferences(options.repos),
					cwd,
					options.description,
				)
				const { content: _, ...output } = record
				log(
					options.json
						? JSON.stringify(output, null, 2)
						: `Created epic '${record.id}'`,
				)
				return
			}

			case "list": {
				const records = yield* epics.list(cwd)
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
				if (!id) return yield* Effect.fail(new Error("Epic ID is required"))
				const record = yield* epics.show(id, cwd)
				const { content: _, ...output } = record
				log(
					options.json
						? JSON.stringify(output, null, 2)
						: record.content.trimEnd(),
				)
				return
			}

			default:
				return yield* Effect.fail(
					new Error(
						"Subcommand is required. Available subcommands: create, list, show",
					),
				)
		}
	})

export const help = `
Usage: agency epic <subcommand>

Subcommands:
  create <id>           Create an epic
  list                  List epics
  show <id>             Show an epic

Create options:
  --ticket-url <url>    External ticket URL
  --description <text>  Short description of the epic
  --repo <alias>:<ref>  Read-only repository reference; repeatable

Options:
  --json                Output results as JSON
`
