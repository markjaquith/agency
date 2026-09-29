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
		if (
			(options.subcommand !== "refresh" && options.subcommand !== "finish") ||
			!options.taskId
		) {
			return yield* Effect.fail(
				new Error("Usage: agency review <refresh|finish> <task>"),
			)
		}
		const service = yield* ReviewService
		const { log } = createLoggers(options)
		if (options.subcommand === "finish") {
			const result = yield* service.finish(
				options.taskId,
				options.cwd,
				options.ifRevision,
			)
			log(
				options.json
					? JSON.stringify(result, null, 2)
					: `Finished review '${options.taskId}'`,
			)
			return
		}
		const result = yield* service.refresh(
			options.taskId,
			options.cwd,
			options.ifRevision,
		)
		log(
			options.json
				? JSON.stringify(result, null, 2)
				: `Refreshed review '${options.taskId}' at ${result.commit}`,
		)
	})

export const help = `
Usage: agency review <refresh|finish> <task-id> [--if-revision <hash>] [--json]

Subcommands:
  refresh    Fetch the review source explicitly and replace the pinned commit
             and any clean, detached review checkout. Review sources never
             move implicitly.
  finish     Mark an open, working, or delegated review task done. Reviews
             have no delivery pull request and need no completion summary.
`
