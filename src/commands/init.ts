import { Effect } from "effect"
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
		const root = yield* workbase.initialize(
			options.path ?? options.cwd ?? process.cwd(),
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
