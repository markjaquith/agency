import { Effect } from "effect"
import {
	type AgencyGraph,
	graphJsonlRecords,
	type GraphInclude,
	type GraphNodeKind,
} from "../graph-schema"
import { GraphService } from "../services/GraphService"
import {
	RuntimeBindingService,
	runtimeSummary,
	unitRuntimeView,
	type RuntimeUnitReference,
} from "../services/RuntimeBindingService"
import { WorkbaseService } from "../services/WorkbaseService"
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
	"ticket",
	"runtime",
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
		const loadedConfig = yield* (yield* WorkbaseService).loadConfig(options.cwd)
		const filters = {
			ready: options.ready,
			blocked: options.blocked,
			statuses,
			repositories: options.repositories,
			kinds,
		}
		let result: AgencyGraph = yield* service.get({
			loadedConfig,
			...filters,
			include,
		})
		if (include.includes("runtime")) {
			const filtered =
				filters.ready !== undefined ||
				filters.blocked !== undefined ||
				statuses.length > 0 ||
				(filters.repositories?.length ?? 0) > 0 ||
				kinds.length > 0
			const allNodes = filtered
				? (yield* service.get({ loadedConfig, kinds: ["execution-unit"] }))
						.nodes
				: result.nodes
			const units = allNodes.flatMap((node): RuntimeUnitReference[] =>
				node.kind === "execution-unit"
					? [
							{
								id: node.id,
								taskId: node.data.taskId,
								...("phaseId" in node.data && node.data.phaseId
									? { phaseId: node.data.phaseId }
									: {}),
								repo:
									"review" in node.data
										? node.data.review.repo
										: node.data.repo,
							},
						]
					: [],
			)
			const inspection = yield* (yield* RuntimeBindingService).inspect(
				loadedConfig.root,
				units,
			)
			result = {
				...result,
				runtime: runtimeSummary(
					inspection,
					new Set(units.map((unit) => unit.id)),
				),
				nodes: result.nodes.map((node) =>
					node.kind === "execution-unit"
						? { ...node, runtime: unitRuntimeView(inspection, node.id) }
						: node,
				),
			}
		}
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
  --include <layer>         Include bodies, workspace, git, pr, ticket, or
                            runtime (repeatable)

The runtime layer reconciles recorded runtime bindings with the live runtime
(Herdr) and infers unbound agent panes from their working directories.
`
