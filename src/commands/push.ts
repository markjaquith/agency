import { Effect } from "effect"
import { PushService } from "../services/PushService"
import type { BaseCommandOptions } from "../utils/command"
import { createLoggers } from "../utils/effect"

export const push = (options: BaseCommandOptions = {}) =>
	Effect.gen(function* () {
		const publications = yield* PushService
		const { log } = createLoggers(options)
		const result = yield* publications.publish(options.cwd ?? process.cwd())
		log(
			options.json
				? JSON.stringify(result, null, 2)
				: `Published ${result.vcs} ${result.branch} at ${result.tip} to ${result.remote}`,
		)
	})

export const help = `
Usage: agency push [--json]

Validate and publish the current Agency execution unit without creating a pull
request. The command uses the durable base and branch declarations, requires the
managed writable checkout and working status, refreshes remote state, validates
every outgoing commit, and rejects non-fast-forward publication.
`
