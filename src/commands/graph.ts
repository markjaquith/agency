import { Effect } from "effect"
import {
	graphJsonlRecords,
	type GraphInclude,
	type GraphNodeKind,
} from "../graph-schema"
import { GraphService } from "../services/GraphService"
import type { WorkStatus } from "../workbase/schemas"
import type { BaseCommandOptions } from "../utils/command"
import { createLoggers } from "../utils/effect"

interface GraphCommandOptions extends BaseCommandOptions {
	readonly json?: boolean
	readonly jsonl?: boolean
	readonly ready?: boolean
	readonly blocked?: boolean
	readonly statuses?: readonly string[]
	readonly repositories?: readonly string[]
	readonly kinds?: readonly string[]
	readonly include?: readonly string[]
}

const allowedStatuses = new Set<WorkStatus>([
	"open",
	"working",
	"delegated",
	"done",
	"dropped",
])
const allowedKinds = new Set<GraphNodeKind>([
	"epic",
	"task",
	"phase",
	"repository",
	"execution-unit",
])
const allowedIncludes = new Set<GraphInclude>([
	"bodies",
	"workspace",
	"git",
	"pr",
])

const validated = <T extends string>(
	label: string,
	values: readonly string[] | undefined,
	allowed: ReadonlySet<T>,
): T[] =>
	(values ?? []).map((value) => {
		if (!allowed.has(value as T)) {
			throw new Error(
				`Invalid --${label} value '${value}'. Expected one of: ${[...allowed].join(", ")}`,
			)
		}
		return value as T
	})

export const graph = (options: GraphCommandOptions = {}) =>
	Effect.gen(function* () {
		const service = yield* GraphService
		const { log } = createLoggers(options)
		const statuses = yield* Effect.sync(() =>
			validated("status", options.statuses, allowedStatuses),
		)
		const kinds = yield* Effect.sync(() =>
			validated("kind", options.kinds, allowedKinds),
		)
		const include = yield* Effect.sync(() =>
			validated("include", options.include, allowedIncludes),
		)
		const result = yield* service.get({
			cwd: options.cwd,
			ready: options.ready,
			blocked: options.blocked,
			statuses,
			repositories: options.repositories,
			kinds,
			include,
		})
		if (options.jsonl) {
			for (const record of graphJsonlRecords(result)) {
				process.stdout.write(`${JSON.stringify(record)}\n`)
			}
			return
		}
		log(JSON.stringify(result, null, 2))
	})

export const help = `
Usage: agency graph [options]

Export the workbase as a deterministic, versioned graph.

Options:
  --json                    Output one versioned machine result
  --jsonl                   Stream versioned graph records
  --ready                   Include only ready nodes
  --blocked                 Include only blocked nodes
  --status <status>         Filter by status (repeatable)
  --repository <alias>      Filter by repository (repeatable)
  --kind <kind>             Filter by entity kind (repeatable)
  --include <layer>         Include bodies, workspace, git, or pr (repeatable)
`
