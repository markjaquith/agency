import { Effect } from "effect"
import { RebaseService } from "../services/RebaseService"
import type { BaseCommandOptions } from "../utils/command"
import { createLoggers } from "../utils/effect"

interface RebaseCommandOptions extends BaseCommandOptions {
	readonly taskId: string
	readonly phaseId?: string
	readonly onto?: string
	readonly from?: string
	readonly dryRun?: boolean
	readonly continue?: boolean
	readonly abort?: boolean
	readonly ifRevision?: string
}

export const rebase = (options: RebaseCommandOptions) =>
	Effect.gen(function* () {
		const service = yield* RebaseService
		const { log } = createLoggers(options)
		const cwd = options.cwd ?? process.cwd()
		const target = { taskId: options.taskId, phaseId: options.phaseId }
		if (options.continue || options.abort) {
			const result = options.continue
				? yield* service.continueRebase(target, cwd)
				: yield* service.abortRebase(target, cwd)
			if (options.json) return log(JSON.stringify(result, null, 2))
			log(
				options.abort
					? `Aborted rebase of ${result.branch}; base metadata unchanged`
					: `Rebased ${result.branch} onto ${describeBase(result)}${result.recorded ? "; recorded base" : ""}`,
			)
			for (const warning of result.warnings) log(`Warning: ${warning}`)
			return
		}
		const result = yield* service.rebase(
			{
				...target,
				onto: options.onto,
				from: options.from,
				dryRun: options.dryRun,
				ifRevision: options.ifRevision,
			},
			cwd,
		)
		if (options.json) return log(JSON.stringify(result, null, 2))
		const base = describeBase(result)
		if (result.status === "up-to-date")
			log(
				`${result.branch} is already based on ${base}${result.recorded ? "; recorded base" : ""}`,
			)
		else if (result.dryRun)
			log(
				`Would rebase ${result.branch} onto ${base}, replaying ${result.replayed.length} commit(s) and dropping ${result.dropped.length} reachable only from the old base`,
			)
		else
			log(
				`Rebased ${result.branch} onto ${base}${result.recorded ? "; recorded base" : ""}`,
			)
		for (const warning of result.warnings) log(`Warning: ${warning}`)
	})

const describeBase = (result: {
	readonly base: string
	readonly previousBase: string
}) =>
	result.base === result.previousBase
		? `'${result.base}'`
		: `'${result.base}' (was '${result.previousBase}')`

export const help = `
Usage: agency rebase <task-id> [phase-id] [--onto <branch>] [options]
       agency rebase <task-id> [phase-id] --continue | --abort

Rebase an execution unit's materialized checkout onto a new base and record the
base only after the rebase succeeds. Requires a clean checkout on the declared
branch. Fetches both bases, then replays only commits after the merge base with
the current base, so commits reachable only from the old base are dropped.
Without --onto, rebases onto the latest current base.

On conflicts, resolve and stage them in the checkout, then run --continue, or
run --abort; base metadata is unchanged until the rebase completes. Dependencies
are never changed. A published branch needs a force-push, and a recorded pull
request needs its GitHub base changed.

Options:
  --onto <branch>        New base branch (default: current base)
  --from <commit>        Last commit not to replay (default: merge base with the
                         current base)
  --dry-run              Report the plan without rebasing or recording
  --continue             Continue after resolving conflicts
  --abort                Abort and leave base metadata unchanged
  --if-revision <hash>   Require the current document revision

Example:
  agency rebase checkout-flow api --onto main --dry-run
`
