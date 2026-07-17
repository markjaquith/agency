import { Effect } from "effect"
import { resolve } from "node:path"
import type { BaseCommandOptions } from "../utils/command"
import { WorkbaseService } from "../services/WorkbaseService"
import { createLoggers } from "../utils/effect"

interface InitOptions extends BaseCommandOptions {
	readonly path?: string
}

export const init = (options: InitOptions = {}) =>
	Effect.gen(function* () {
		const workbase = yield* WorkbaseService
		const { log } = createLoggers(options)
		const cwd = options.cwd ?? process.cwd()
		const root = yield* workbase.initialize(
			options.path ? resolve(cwd, options.path) : cwd,
		)
		log(
			options.json
				? JSON.stringify({ root }, null, 2)
				: `Initialized Agency workbase at ${root}`,
		)
	})

export const help = `
Usage: agency init [path]

Initialize an Agency workbase. The current directory is used when path is
omitted.

Options:
  --json              Output the initialized workbase as JSON
`
