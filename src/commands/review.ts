import { Effect } from "effect"
import { ReviewService } from "../services/ReviewService"
import { autoArchiveMessage } from "../services/auto-archive"
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
		if (options.subcommand !== "refresh" && options.subcommand !== "finish") {
			return yield* Effect.fail(
				new Error("Usage: agency review <refresh|finish> [task]"),
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
					: `Finished review '${result.id}'`,
			)
			const notice = autoArchiveMessage(result.autoArchive)
			if (!options.json && notice) log(notice)
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
				: `Refreshed review '${result.taskId}' at ${result.commit}`,
		)
	})

export const help = `
Usage: agency review refresh [task] [--if-revision <hash>] [--json]
       agency review finish [task] [--if-revision <hash>] [--json]

The task is an ID or a path to the task document, its directory, or anything
inside it, such as the review checkout. When omitted, the task containing the
current directory is used.

Subcommands:
  refresh    Fetch the review source explicitly and replace the pinned commit
             and any clean, detached review checkout. Review sources never
             move implicitly.
  finish     Mark an open, working, or delegated review task done. Reviews
             have no delivery pull request and need no completion summary.
`
