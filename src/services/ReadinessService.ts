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

const isResumableWork = (node: GraphNode) =>
	node.kind !== "repository" &&
	node.status === "working" &&
	node.readiness.blockers.every((blocker) => blocker.kind !== "validation")

const isWorkTarget = (node: GraphNode) =>
	node.kind !== "repository" && (node.readiness.ready || isResumableWork(node))

const itemFor = (
	node: ExecutionNode,
	tasks: ReadonlyMap<string, Extract<GraphNode, { readonly kind: "task" }>>,
	executionsByTask: ReadonlyMap<string, readonly ExecutionNode[]>,
	rank: number,
): NextItem => {
	const task = tasks.get(node.data.taskId)
	const epicId =
		task?.kind === "task" && typeof task.data.epic === "string"
			? task.data.epic
			: undefined
	const dependentIds = new Set(node.dependents)
	if ("phaseId" in node.data && node.data.phaseId) {
		const siblings = (executionsByTask.get(node.data.taskId) ?? []).filter(
			(candidate) => candidate.id !== node.id,
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
		...("phaseId" in node.data && node.data.phaseId
			? { phaseId: node.data.phaseId }
			: {}),
		...(node.data.description ? { description: node.data.description } : {}),
		parent: {
			...("phaseId" in node.data && node.data.phaseId
				? { taskId: node.data.taskId }
				: {}),
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

const rankedItems = (graph: AgencyGraph) => {
	const tasks = new Map<string, Extract<GraphNode, { readonly kind: "task" }>>()
	const executionsByTask = new Map<string, ExecutionNode[]>()
	const executions: ExecutionNode[] = []
	for (const node of graph.nodes) {
		if (node.kind === "task") tasks.set(node.key, node)
		if (node.kind !== "execution-unit") continue
		executions.push(node)
		const siblings = executionsByTask.get(node.data.taskId)
		if (siblings) siblings.push(node)
		else executionsByTask.set(node.data.taskId, [node])
	}
	return executions
		.map((node) => itemFor(node, tasks, executionsByTask, 0))
		.sort(
			(left, right) =>
				right.priority.dependentCount - left.priority.dependentCount ||
				left.key.localeCompare(right.key),
		)
		.map((item, index) => ({ ...item, rank: index + 1 }))
}

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

			getWorkTargetIds: (cwd: string = process.cwd()) =>
				Effect.gen(function* () {
					const graphs = yield* GraphService
					const graph = yield* graphs.get({ cwd })
					return new Set(
						graph.nodes.filter(isWorkTarget).map((node) => node.id),
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
					const graphs = yield* GraphService
					const graph = yield* graphs.get({ cwd })
					const node = graph.nodes.find((candidate) => candidate.id === target)
					if (!node || !node.readiness) {
						if (override) return
						return yield* new ExecutionGuardError({
							message: `Work target '${target}' was not found in the work graph.`,
							action: "work",
							target,
							status: "open",
							blockedBy: [],
							blockers: [],
						})
					}
					if (override) return
					if (!node.readiness.ready && !isResumableWork(node)) {
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
