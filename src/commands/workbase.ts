import { Effect } from "effect"
import { resolve } from "node:path"
import type { BaseCommandOptions } from "../utils/command"
import { WorkbaseService } from "../services/WorkbaseService"
import { createLoggers } from "../utils/effect"

interface WorkbaseOptions extends BaseCommandOptions {
	readonly subcommand?: string
	readonly args: readonly string[]
	readonly configDirectory?: string
	readonly name?: string
	readonly clear?: boolean
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
				const registration = yield* service.register(
					resolve(options.cwd ?? process.cwd(), path),
					options.configDirectory,
					options.name,
				)
				log(
					options.json
						? JSON.stringify(registration, null, 2)
						: `Added workbase ${registration.name ?? registration.id} (${registration.path})`,
				)
				return
			}
			case "list": {
				const registrations = yield* service.listRegistrations(
					options.configDirectory,
				)
				if (options.json) {
					log(JSON.stringify(registrations, null, 2))
				} else {
					for (const entry of registrations.workbases) {
						const marker = entry.id === registrations.defaultId ? "*" : " "
						log(`${marker} ${entry.name ?? entry.id}\t${entry.path}`)
					}
				}
				return
			}
			case "show": {
				const selector = options.args[0]
				if (!selector) {
					return yield* Effect.fail(
						new Error("Usage: agency workbase show <selector>"),
					)
				}
				const entry = yield* service.showRegistered(
					selector,
					options.configDirectory,
					options.cwd,
				)
				log(
					options.json
						? JSON.stringify(entry, null, 2)
						: `${entry.name ?? entry.id}\t${entry.path}`,
				)
				return
			}
			case "name": {
				const selector = options.args[0]
				const name = options.clear ? null : options.args[1]
				if (
					!selector ||
					name === undefined ||
					(options.clear && options.args[1] !== undefined)
				) {
					return yield* Effect.fail(
						new Error(
							"Usage: agency workbase name <selector> <name> | --clear",
						),
					)
				}
				const entry = yield* service.nameRegistered(
					selector,
					name,
					options.configDirectory,
					options.cwd,
				)
				log(
					options.json
						? JSON.stringify(entry, null, 2)
						: name === null
							? `Cleared name for ${entry.id}`
							: `Named workbase ${name}`,
				)
				return
			}
			case "remove": {
				const entry = yield* service.removeRegistered(
					options.args[0]!,
					options.configDirectory,
					options.cwd,
				)
				log(
					options.json
						? JSON.stringify(entry, null, 2)
						: `Removed workbase ${entry.name ?? entry.id}`,
				)
				return
			}
			case "prune": {
				const removed = yield* service.pruneRegistered(options.configDirectory)
				log(
					options.json
						? JSON.stringify(removed, null, 2)
						: `Pruned ${removed.length} stale workbase${removed.length === 1 ? "" : "s"}`,
				)
				return
			}
			case "default": {
				const selector = options.clear ? null : options.args[0]
				if (selector === undefined) {
					const entry = yield* service.getDefault(options.configDirectory)
					log(
						options.json
							? JSON.stringify(entry ?? null, null, 2)
							: entry
								? `${entry.name ?? entry.id}\t${entry.path}`
								: "No default workbase",
					)
					return
				}
				const entry = yield* service.setDefault(
					selector,
					options.configDirectory,
					options.cwd,
				)
				log(
					options.json
						? JSON.stringify(entry, null, 2)
						: entry
							? `Default workbase is ${entry.name ?? entry.id}`
							: "Cleared default workbase",
				)
				return
			}
			default:
				return yield* Effect.fail(
					new Error(
						"Subcommand is required. Available: add, list, show, name, remove, prune, default",
					),
				)
		}
	})

export const help = `
Usage: agency workbase <subcommand>

Subcommands:
  add <path>        Register an Agency workbase
  list              List registered workbases
  show <selector>   Show a registered workbase
  name <selector>   Set or clear a registered workbase name
  remove <selector> Remove a registered workbase
  prune             Remove registrations whose paths no longer exist
  default [selector] Show or set the default workbase

Options:
  --name <name> Name a registered workbase
  --clear       Clear the default workbase
  --json        Output results as JSON
`
