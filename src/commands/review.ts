import { Effect } from "effect"
import { ReviewService } from "../services/ReviewService"
import type { BaseCommandOptions } from "../utils/command"
import { createLoggers } from "../utils/effect"

interface ReviewOptions extends BaseCommandOptions {
	readonly subcommand?: string
	readonly taskId?: string
	readonly ifRevision?: string
	readonly json?: boolean
}

export const review = (options: ReviewOptions) =>
	Effect.gen(function* () {
		if (options.subcommand !== "refresh" || !options.taskId) {
			return yield* Effect.fail(
				new Error("Usage: agency review refresh <task>"),
			)
		}
		const result = yield* (yield* ReviewService).refresh(
			options.taskId,
			options.cwd,
			options.ifRevision,
		)
		const { log } = createLoggers(options)
		log(
			options.json
				? JSON.stringify(result, null, 2)
				: `Refreshed review '${options.taskId}' at ${result.commit}`,
		)
	})

export const help = `
Usage: agency review refresh <task-id> [--if-revision <hash>] [--json]

Fetch the review source explicitly and replace the pinned commit and any clean,
detached review checkout. Review sources never move implicitly.
`
