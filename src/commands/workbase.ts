import { Effect } from "effect"
import type { BaseCommandOptions } from "../utils/command"
import { WorkbaseService } from "../services/WorkbaseService"
import { createLoggers } from "../utils/effect"

interface WorkbaseOptions extends BaseCommandOptions {
	readonly subcommand?: string
	readonly args: readonly string[]
	readonly configDirectory?: string
}

export const workbase = (options: WorkbaseOptions) =>
	Effect.gen(function* () {
		const service = yield* WorkbaseService
		const { log } = createLoggers(options)

		switch (options.subcommand) {
			case "add": {
				const path = options.args[0]
				if (!path) {
					return yield* Effect.fail(
						new Error("Usage: agency workbase add <path>"),
					)
				}
				const root = yield* service.register(path, options.configDirectory)
				log(
					options.json
						? JSON.stringify({ path: root }, null, 2)
						: `Added workbase ${root}`,
				)
				return
			}
			case "list": {
				const workbases = yield* service.listRegistered(options.configDirectory)
				if (options.json) {
					log(JSON.stringify(workbases, null, 2))
				} else {
					for (const path of workbases) log(path)
				}
				return
			}
			default:
				return yield* Effect.fail(
					new Error("Subcommand is required. Available: add, list"),
				)
		}
	})

export const help = `
Usage: agency workbase <subcommand>

Subcommands:
  add <path>  Register an Agency workbase
  list        List registered workbases

Options:
  --json      Output results as JSON
`
