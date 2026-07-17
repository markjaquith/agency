import { Effect } from "effect"
import type { BaseCommandOptions } from "../utils/command"
import { PullRequestService } from "../services/PullRequestService"
import { createLoggers } from "../utils/effect"

interface PrOptions extends BaseCommandOptions {
	readonly subcommand?: string
	readonly taskId?: string
	readonly phaseId?: string
	readonly draft?: boolean
	readonly force?: boolean
}

export const pr = (options: PrOptions) =>
	Effect.gen(function* () {
		if (options.subcommand !== "create" || !options.taskId) {
			return yield* Effect.fail(
				new Error("Usage: agency pr create <task-id> [phase-id]"),
			)
		}
		const pullRequests = yield* PullRequestService
		const { log } = createLoggers(options)
		const url = yield* pullRequests.create(
			options.taskId,
			options.phaseId,
			options.draft,
			options.cwd ?? process.cwd(),
			options,
		)
		log(options.json ? JSON.stringify({ url }, null, 2) : url)
	})

export const help = `
Usage: agency pr create <task-id> [phase-id]

Push the execution branch, create a GitHub pull request, and update its
task or phase document.

Options:
  --draft             Create a draft pull request
  --force             Override readiness and terminal-state guards
  --json              Output the pull request URL as JSON
`
