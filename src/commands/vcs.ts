import { Effect } from "effect"
import { VcsMigrationService } from "../services/VcsMigrationService"
import type { BaseCommandOptions } from "../utils/command"
import { createLoggers } from "../utils/effect"

interface VcsOptions extends BaseCommandOptions {
	readonly subcommand?: string
	readonly target?: string
	readonly apply?: boolean
}

export const vcs = (options: VcsOptions = {}) =>
	Effect.gen(function* () {
		const migrations = yield* VcsMigrationService
		const { log } = createLoggers(options)
		const root = options.cwd ?? process.cwd()
		if (options.subcommand === "status") {
			const status = yield* migrations.status(root)
			if (options.json) return log(JSON.stringify(status, null, 2))
			log(
				`Version control: ${status.source}${status.configured ? "" : " (inferred for legacy workbase)"}`,
			)
			log(
				`Tools: git=${status.available.git ? "available" : "missing"} jj=${status.available.jj ? "available" : "missing"}`,
			)
			log(
				`Repositories: ${status.repositories.length}; managed workspaces: ${status.workspaceCount}; blockers: ${status.blockers.length}`,
			)
			for (const blocker of status.blockers)
				log(`blocker ${blocker.kind} ${blocker.target}: ${blocker.message}`)
			return
		}
		if (options.subcommand === "migrate") {
			if (options.target !== "git" && options.target !== "jj") {
				return yield* Effect.fail(
					new Error("VCS migration target must be 'git' or 'jj'"),
				)
			}
			const result = yield* migrations.migrate(options.target, root, {
				apply: options.apply,
			})
			if (options.json) return log(JSON.stringify(result, null, 2))
			log(
				result.mode === "apply"
					? `Migrated workbase to ${options.target}`
					: `Migration plan: ${result.source} -> ${options.target}`,
			)
			for (const action of result.actions) log(`- ${action}`)
			if (result.mode === "dry-run" && result.actions.length > 0)
				log("Run again with --apply to perform the migration.")
			return
		}
		return yield* Effect.fail(
			new Error(`Unknown vcs subcommand '${options.subcommand ?? ""}'`),
		)
	})

export const help = `
Usage: agency vcs <status|migrate>

Inspect or migrate the workbase-wide version-control backend.

Commands:
  status                         Show the configured backend, tools, repositories, and blockers
  migrate <git|jj> [--dry-run | --apply]
                                 Preview or apply a clean, transactional backend migration

Options:
  --apply              Apply the migration; omission performs a dry run
  --dry-run            Explicitly preview the migration without applying it
  --json               Print structured output
`
