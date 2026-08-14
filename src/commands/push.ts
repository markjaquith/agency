import { Effect } from "effect"
import { PushService } from "../services/PushService"
import type { BaseCommandOptions } from "../utils/command"
import { createLoggers } from "../utils/effect"
import { createProgress, type Progress } from "../utils/progress"

const stageMessage = {
	context: "Inspecting Agency execution context",
	fetch: "Fetching remote state",
	inspect: "Selecting the publication tip",
	validate: "Validating outgoing changes",
	publish: "Publishing the declared branch",
} as const

export const push = (
	options: BaseCommandOptions = {},
	progress: Progress = createProgress({ silent: options.silent }),
) =>
	Effect.gen(function* () {
		const publications = yield* PushService
		const { log } = createLoggers(options)
		const showProgress = !options.silent
		const result = yield* publications
			.publish(options.cwd ?? process.cwd(), {
				onProgress: showProgress
					? (stage) => progress.start(stageMessage[stage])
					: undefined,
			})
			.pipe(
				Effect.tapError(() =>
					Effect.sync(() => {
						if (showProgress) progress.fail("Publication failed")
					}),
				),
			)
		if (showProgress)
			progress.succeed(`Published ${result.branch} to ${result.remote}`)
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
