import { Effect } from "effect"
import { PushService } from "../services/PushService"
import type { BaseCommandOptions } from "../utils/command"
import { createLoggers } from "../utils/effect"
import { createProgress, type Progress } from "../utils/progress"

interface PushCommandOptions extends BaseCommandOptions {
	readonly forceWithLease?: boolean
}

const stageMessage = {
	context: "Inspecting Agency execution context",
	fetch: "Fetching remote state",
	inspect: "Selecting the publication tip",
	validate: "Validating outgoing changes",
	publish: "Publishing the declared branch",
	reconcile: "Confirming the remote publication outcome",
} as const

export const push = (
	options: PushCommandOptions = {},
	progress: Progress = createProgress({ silent: options.silent }),
) =>
	Effect.gen(function* () {
		const publications = yield* PushService
		const { log } = createLoggers(options)
		const showProgress = !options.silent
		const result = yield* publications
			.publish(options.cwd ?? process.cwd(), {
				forwardOutput: options.verbose,
				forceWithLease: options.forceWithLease,
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
				: `Published ${result.vcs} ${result.branch} at ${result.tip} to ${result.remote}${result.forcedOver ? ` (replaced ${result.forcedOver})` : ""}`,
		)
	})

export const help = `
Usage: agency push [--force-with-lease] [--json]

Validate and publish the current Agency execution unit without creating a pull
request. The command uses the durable base and branch declarations, requires the
managed writable checkout and working status, refreshes remote state, validates
every outgoing commit, and rejects non-fast-forward publication by default.

After rewriting published history (amend, rebase, or squash), publish with
--force-with-lease instead of a raw git push. The lease is the remote branch tip
this checkout last observed; publication is refused if the remote has moved
since then or holds commits never integrated into the local branch.

Options:
  --force-with-lease     Replace rewritten remote history if it is unchanged
                         since last observed
`
