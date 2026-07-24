import { Effect } from "effect"
import { ClaimService } from "../services/ClaimService"
import type { BaseCommandOptions } from "../utils/command"
import { createLoggers } from "../utils/effect"

interface ClaimCommandOptions extends BaseCommandOptions {
	readonly operation: "claim" | "release" | "finish"
	readonly taskId?: string
	readonly phaseId?: string
	readonly claimant?: string
	readonly runner?: string
	readonly sessionId?: string
	readonly revision?: string
	readonly expiresAt?: string
	readonly outcome?: string
	readonly noPullRequest?: boolean
	readonly summary?: string
	readonly evidenceUrl?: string
	readonly json?: boolean
}

export const claimCommand = (options: ClaimCommandOptions) =>
	Effect.gen(function* () {
		const claims = yield* ClaimService
		const { log } = createLoggers(options)
		const cwd = options.cwd ?? process.cwd()
		if (!options.taskId || !options.sessionId || !options.revision) {
			return yield* Effect.fail(new Error("Missing required claim arguments"))
		}
		if (
			options.operation === "claim" &&
			(!options.claimant || !options.runner)
		) {
			return yield* Effect.fail(
				new Error("Claimant and runner identities are required"),
			)
		}
		if (options.noPullRequest && !options.summary?.trim()) {
			return yield* Effect.fail(
				new Error("Non-PR completion requires a non-empty summary"),
			)
		}
		if (options.noPullRequest && options.outcome !== "done") {
			return yield* Effect.fail(
				new Error("Non-PR completion is valid only with a done outcome"),
			)
		}
		if (
			options.operation === "finish" &&
			options.outcome !== "done" &&
			options.outcome !== "dropped"
		) {
			return yield* Effect.fail(
				new Error("Finish outcome must be done or dropped"),
			)
		}

		const common = {
			taskId: options.taskId,
			...(options.phaseId ? { phaseId: options.phaseId } : {}),
			sessionId: options.sessionId,
			revision: options.revision,
		}
		const result =
			options.operation === "claim"
				? yield* claims.claim(
						{
							...common,
							claimant: options.claimant!,
							runner: options.runner!,
							...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
						},
						cwd,
					)
				: options.operation === "release"
					? yield* claims.release(common, cwd)
					: yield* claims.finish(
							{
								...common,
								outcome: options.outcome as "done" | "dropped",
								...(options.noPullRequest
									? {
											nonPrCompletion: {
												summary: options.summary!,
												...(options.evidenceUrl
													? { evidenceUrl: options.evidenceUrl }
													: {}),
											},
										}
									: {}),
							},
							cwd,
						)

		const { data: _, ...output } = result
		log(
			options.json
				? JSON.stringify(output, null, 2)
				: `${options.operation === "claim" ? "Claimed" : options.operation === "release" ? "Released" : "Finished"} ${result.target} at revision ${result.revision}`,
		)
	})

export const claimHelp = `
Usage: agency claim <task-id> [phase-id] --claimant <id> --runner <id> --session-id <id> --revision <sha256>

Claim an execution unit. Use distinct claimant and runner identities for delegated
work. --expires-at accepts an optional future ISO-8601 timestamp.
`

export const releaseHelp = `
Usage: agency release <task-id> [phase-id] --session-id <id> --revision <sha256>

Release an execution unit owned by the session.
`

export const finishHelp = `
Usage: agency finish <task-id> [phase-id] --session-id <id> --revision <sha256> --outcome <done|dropped> [--no-pull-request --summary <text> [--evidence-url <url>]]

Finish a claim owned by the session. A done claim outcome leaves unmerged work
working; agency sync --apply marks the execution unit done after merge. Use
--no-pull-request with a summary for an explicit non-PR completion.
`
