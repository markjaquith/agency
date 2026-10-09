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
		if (
			(options.subcommand !== "refresh" && options.subcommand !== "finish") ||
			(options.subcommand === "refresh" && !options.taskId)
		) {
			return yield* Effect.fail(
				new Error(
					"Usage: agency review refresh <task> | agency review finish [task-or-path]",
				),
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
			options.taskId!,
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
Usage: agency review refresh <task-id> [--if-revision <hash>] [--json]
       agency review finish [<task-id-or-path>] [--if-revision <hash>] [--json]

Subcommands:
  refresh    Fetch the review source explicitly and replace the pinned commit
             and any clean, detached review checkout. Review sources never
             move implicitly.
  finish     Mark an open, working, or delegated review task done. Reviews
             have no delivery pull request and need no completion summary.
             The target is a task ID or a path inside the task directory;
             it defaults to the current directory.
`
