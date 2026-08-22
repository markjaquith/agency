import { Effect } from "effect"
import { resolve } from "node:path"
import { ContextService } from "../services/ContextService"
import { FileSystemService } from "../services/FileSystemService"
import { PullRequestService } from "../services/PullRequestService"
import type { BaseCommandOptions } from "../utils/command"
import { createLoggers } from "../utils/effect"

interface PrCreateOptions extends BaseCommandOptions {
	readonly taskId: string
	readonly phaseId?: string
	readonly draft?: boolean
	readonly force?: boolean
	readonly title?: string
	readonly head?: string
	readonly base?: string
	readonly labels?: readonly string[]
}

export const prCreate = (options: PrCreateOptions) =>
	Effect.gen(function* () {
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

export const pr = (args: readonly string[], cwd: string = process.cwd()) =>
	Effect.gen(function* () {
		const contexts = yield* ContextService
		const fs = yield* FileSystemService
		const invocationCwd = resolve(cwd)
		const context = yield* contexts
			.get({ cwd: invocationCwd, target: ".", compact: true })
			.pipe(Effect.catchAll(() => Effect.succeed(null)))
		const writableCheckout =
			context?.validation.valid && context.workspace?.writable?.materialized
				? context.authority.writable?.checkoutPath
				: null
		const reviewCheckout =
			context?.validation.valid && context.review?.checkout?.materialized
				? context.review.checkout.checkoutPath
				: null
		const focusedCheckout = writableCheckout ?? reviewCheckout
		const focusedCwd = focusedCheckout ?? invocationCwd
		const result = yield* fs.runCommand(["gh", "pr", ...args], {
			cwd: focusedCwd,
			passthrough: true,
		})
		return result.exitCode
	})

export const help = `
Usage: agency pr create <task-id> [phase-id] [options]
       agency pr [args...]

Create records a pull request for an Agency execution unit and accepts the
options listed below. Invocations without an Agency task target run gh pr
unchanged, focusing the writable repository checkout when invoked from
an Agency execution task or phase.

Options:
  --draft                   Create the pull request as a draft
  --title <title>           Override the generated pull request title
  --head <branch>           Confirm the declared head branch
  --base <branch>           Confirm the declared base branch
  --label <label>           Add a label (repeatable)
  --force                   Override readiness checks
  --json                    Output one versioned machine result
`
