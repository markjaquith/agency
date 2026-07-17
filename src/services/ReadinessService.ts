import { Data, Effect } from "effect"
import type { AgencyGraph, GraphBlocker, GraphNode } from "../graph-schema"
import type { WorkStatus } from "../workbase/schemas"
import { GraphService } from "./GraphService"

type ExecutionNode = Extract<GraphNode, { readonly kind: "execution-unit" }>

interface NextItem {
	readonly rank: number
	readonly key: string
	readonly taskId: string
	readonly phaseId?: string
	readonly description?: string
	readonly parent: {
		readonly taskId?: string
		readonly epicId?: string
	}
	readonly status: WorkStatus
	readonly repositories: readonly string[]
	readonly priority: {
		readonly dependentCount: number
	}
	readonly ready: boolean
	readonly terminal: boolean
	readonly blockedBy: readonly string[]
	readonly blockers: readonly GraphBlocker[]
}

interface NextResult {
	readonly ready: readonly NextItem[]
	readonly excluded: readonly NextItem[]
	readonly selected?: NextItem
}

class ExecutionGuardError extends Data.TaggedError("ExecutionGuardError")<{
	readonly message: string
	readonly action: "work" | "pr"
	readonly target: string
	readonly status: WorkStatus
	readonly blockedBy: readonly string[]
	readonly blockers: readonly GraphBlocker[]
}> {}

const executionNodeId = (taskId: string, phaseId?: string) =>
	phaseId
		? `execution-unit:phase/${taskId}/${phaseId}`
		: `execution-unit:task/${taskId}`

const itemFor = (
	node: ExecutionNode,
	graph: AgencyGraph,
	rank: number,
): NextItem => {
	const task = graph.nodes.find(
		(candidate) =>
			candidate.kind === "task" && candidate.key === node.data.taskId,
	)
	const epicId =
		task?.kind === "task" && typeof task.data.epic === "string"
			? task.data.epic
			: undefined
	const dependentIds = new Set(node.dependents)
	if (node.data.phaseId) {
		const siblings = graph.nodes.filter(
			(candidate): candidate is ExecutionNode =>
				candidate.kind === "execution-unit" &&
				candidate.data.taskId === node.data.taskId &&
				candidate.id !== node.id,
		)
		if (siblings.every((sibling) => sibling.status === "done")) {
			for (const dependent of task?.dependents ?? [])
				dependentIds.add(dependent)
		}
	}
	return {
		rank,
		key: node.key,
		taskId: node.data.taskId,
		...(node.data.phaseId ? { phaseId: node.data.phaseId } : {}),
		...(node.data.description ? { description: node.data.description } : {}),
		parent: {
			...(node.data.phaseId ? { taskId: node.data.taskId } : {}),
			...(epicId ? { epicId } : {}),
		},
		status: node.status,
		repositories: node.repositories,
		priority: { dependentCount: dependentIds.size },
		ready: node.readiness.ready,
		terminal: node.readiness.terminal,
		blockedBy: node.readiness.blockedBy,
		blockers: node.readiness.blockers,
	}
}

const rankedItems = (graph: AgencyGraph) =>
	graph.nodes
		.filter((node): node is ExecutionNode => node.kind === "execution-unit")
		.map((node) => itemFor(node, graph, 0))
		.sort(
			(left, right) =>
				right.priority.dependentCount - left.priority.dependentCount ||
				left.key.localeCompare(right.key),
		)
		.map((item, index) => ({ ...item, rank: index + 1 }))

const guardMessage = (
	action: "work" | "pr",
	item: Pick<NextItem, "key" | "status" | "blockers">,
) => {
	const reasons = item.blockers.map((blocker) => blocker.reason)
	return `Cannot ${action === "work" ? "work on" : "create a pull request for"} '${item.key}': ${reasons.length > 0 ? reasons.join("; ") : `status is ${item.status}`}. Use --force to override.`
}

export class ReadinessService extends Effect.Service<ReadinessService>()(
	"ReadinessService",
	{
		sync: () => ({
			getReadyWorkTargetIds: (cwd: string = process.cwd()) =>
				Effect.gen(function* () {
					const graphs = yield* GraphService
					const graph = yield* graphs.get({ cwd })
					return new Set(
						graph.nodes
							.filter((node) => node.readiness?.ready)
							.map((node) => node.id),
					)
				}),

			getNext: (cwd: string = process.cwd(), select = false) =>
				Effect.gen(function* () {
					const graphs = yield* GraphService
					const graph = yield* graphs.get({ cwd })
					const items = rankedItems(graph)
					const ready = items
						.filter((item) => item.ready)
						.map((item, index) => ({ ...item, rank: index + 1 }))
					const excluded = items
						.filter((item) => !item.ready)
						.map((item, index) => ({ ...item, rank: index + 1 }))
					return {
						ready,
						excluded,
						...(select && ready[0] ? { selected: ready[0] } : {}),
					} satisfies NextResult
				}),

			guardWorkTarget: (
				target: string,
				cwd: string = process.cwd(),
				override = false,
			) =>
				Effect.gen(function* () {
					if (override) return
					const graphs = yield* GraphService
					const graph = yield* graphs.get({ cwd })
					const node = graph.nodes.find((candidate) => candidate.id === target)
					if (!node || !node.readiness) {
						return yield* new ExecutionGuardError({
							message: `Work target '${target}' was not found in the work graph.`,
							action: "work",
							target,
							status: "open",
							blockedBy: [],
							blockers: [],
						})
					}
					if (!node.readiness.ready) {
						const item = {
							key: node.key,
							status: node.status!,
							blockers: node.readiness.blockers,
						}
						return yield* new ExecutionGuardError({
							message: guardMessage("work", item),
							action: "work",
							target,
							status: node.status!,
							blockedBy: node.readiness.blockedBy,
							blockers: node.readiness.blockers,
						})
					}
				}),

			guard: (
				action: "work" | "pr",
				taskId: string,
				phaseId?: string,
				cwd: string = process.cwd(),
				override = false,
			) =>
				Effect.gen(function* () {
					if (override) return
					const graphs = yield* GraphService
					const graph = yield* graphs.get({ cwd })
					const items = rankedItems(graph)
					const key = phaseId ? `phase/${taskId}/${phaseId}` : `task/${taskId}`
					const item = items.find((candidate) => candidate.key === key)
					if (!item) {
						return yield* new ExecutionGuardError({
							message: `Execution unit '${key}' was not found in the work graph.`,
							action,
							target: executionNodeId(taskId, phaseId),
							status: "open",
							blockedBy: [],
							blockers: [],
						})
					}
					const actionable =
						action === "work"
							? item.ready
							: !item.terminal &&
								!item.blockers.some(
									(blocker) =>
										blocker.kind === "dependency" ||
										blocker.kind === "validation",
								)
					if (!actionable) {
						return yield* new ExecutionGuardError({
							message: guardMessage(action, item),
							action,
							target: executionNodeId(taskId, phaseId),
							status: item.status,
							blockedBy: item.blockedBy,
							blockers: item.blockers,
						})
					}
				}),
		}),
	},
) {}
