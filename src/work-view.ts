import { Effect } from "effect"
import type { GraphNode } from "./graph-schema"
import { GraphService } from "./services/GraphService"
import type { ValidationReport } from "./services/WorkbaseService"
import type { WorkStatus } from "./workbase/schemas"

type WorkNode = Extract<
	GraphNode,
	{ readonly kind: "epic" | "task" | "phase" | "execution-unit" }
>
type EntityNode = Exclude<WorkNode, { readonly kind: "execution-unit" }>
type ExecutionNode = Extract<WorkNode, { readonly kind: "execution-unit" }>

export interface WorkViewOptions {
	readonly cwd?: string
	readonly validation?: ValidationReport
	readonly statuses?: readonly string[]
	readonly repositories?: readonly string[]
	readonly ready?: boolean
	readonly blocked?: boolean
	readonly pr?: boolean
}

export interface WorkViewRow {
	readonly kind: "epic" | "task" | "phase"
	readonly id: string
	readonly key: string
	readonly revision: string
	readonly parent: string
	readonly status: WorkStatus
	readonly readiness: "ready" | "blocked" | "waiting" | "terminal"
	readonly repositories: string
	readonly branch: string
	readonly pr: string
	readonly worktree: string
	readonly hasPr: boolean
}

const allowedStatuses = new Set<WorkStatus>([
	"open",
	"working",
	"delegated",
	"done",
	"dropped",
])

const validatedStatuses = (values: readonly string[] | undefined) =>
	(values ?? []).map((value) => {
		if (!allowedStatuses.has(value as WorkStatus)) {
			throw new Error(
				`Invalid --status value '${value}'. Expected one of: ${[...allowedStatuses].join(", ")}`,
			)
		}
		return value as WorkStatus
	})

const readinessLabel = (node: EntityNode): WorkViewRow["readiness"] =>
	node.readiness.ready
		? "ready"
		: node.readiness.terminal
			? "terminal"
			: node.readiness.blocked
				? "blocked"
				: "waiting"

const aggregateLabel = (
	executions: readonly ExecutionNode[],
	predicate: (node: ExecutionNode) => boolean,
	singular: readonly [present: string, absent: string],
) => {
	if (executions.length === 0) return "-"
	const count = executions.filter(predicate).length
	if (executions.length === 1) return count === 1 ? singular[0] : singular[1]
	return `${count}/${executions.length} ${singular[0]}`
}

const rowFor = (
	node: EntityNode,
	executions: readonly ExecutionNode[],
): WorkViewRow => {
	const branches = [
		...new Set(
			executions.flatMap((execution) =>
				"branch" in execution.data ? [execution.data.branch] : [],
			),
		),
	]
	const parent =
		node.kind === "task"
			? (node.data.epic ?? "-")
			: node.kind === "phase"
				? node.key.slice(0, node.key.indexOf("/"))
				: "-"
	const id =
		node.kind === "phase" ? node.key.slice(node.key.indexOf("/") + 1) : node.key

	return {
		kind: node.kind,
		id,
		key: node.key,
		revision: node.data.sha256,
		parent,
		status: node.status,
		readiness: readinessLabel(node),
		repositories: node.repositories.join(",") || "-",
		branch:
			branches.length === 0
				? "-"
				: branches.length === 1
					? branches[0]!
					: "multiple",
		pr: aggregateLabel(
			executions,
			(execution) => "pr" in execution.data && Boolean(execution.data.pr),
			["present", "absent"],
		),
		worktree: aggregateLabel(
			executions,
			(execution) => execution.workspace?.materialized === true,
			["materialized", "absent"],
		),
		hasPr: executions.some(
			(execution) => "pr" in execution.data && Boolean(execution.data.pr),
		),
	}
}

const orderedTasks = (
	epics: readonly Extract<EntityNode, { readonly kind: "epic" }>[],
	tasks: ReadonlyMap<string, Extract<EntityNode, { readonly kind: "task" }>>,
) => {
	const ordered: Extract<EntityNode, { readonly kind: "task" }>[] = []
	const seen = new Set<string>()
	for (const epic of epics) {
		for (const item of epic.data.tasks) {
			const task = tasks.get(item.id)
			if (task && !seen.has(task.key)) {
				ordered.push(task)
				seen.add(task.key)
			}
		}
	}
	for (const task of [...tasks.values()].sort((a, b) =>
		a.key.localeCompare(b.key),
	)) {
		if (!seen.has(task.key)) ordered.push(task)
	}
	return ordered
}

const orderedPhases = (
	task: Extract<EntityNode, { readonly kind: "task" }>,
	phases: ReadonlyMap<string, Extract<EntityNode, { readonly kind: "phase" }>>,
) => {
	const ordered: Extract<EntityNode, { readonly kind: "phase" }>[] = []
	const seen = new Set<string>()
	if ("phases" in task.data) {
		for (const item of task.data.phases) {
			const phase = phases.get(`${task.key}/${item.id}`)
			if (phase) {
				ordered.push(phase)
				seen.add(phase.key)
			}
		}
	}
	for (const phase of [...phases.values()]
		.filter((value) => value.key.startsWith(`${task.key}/`))
		.sort((a, b) => a.key.localeCompare(b.key))) {
		if (!seen.has(phase.key)) ordered.push(phase)
	}
	return ordered
}

export const getWorkViews = (options: WorkViewOptions = {}) =>
	Effect.gen(function* () {
		const graphService = yield* GraphService
		const statuses = yield* Effect.sync(() =>
			validatedStatuses(options.statuses),
		)
		const graph = yield* graphService.get({
			cwd: options.cwd,
			validation: options.validation,
			include: ["workspace"],
		})
		const workNodes = graph.nodes.filter(
			(node): node is WorkNode => node.kind !== "repository",
		)
		const epics = workNodes
			.filter(
				(node): node is Extract<EntityNode, { readonly kind: "epic" }> =>
					node.kind === "epic",
			)
			.sort((a, b) => a.key.localeCompare(b.key))
		const tasks = new Map(
			workNodes
				.filter(
					(node): node is Extract<EntityNode, { readonly kind: "task" }> =>
						node.kind === "task",
				)
				.map((node) => [node.key, node]),
		)
		const phases = new Map(
			workNodes
				.filter(
					(node): node is Extract<EntityNode, { readonly kind: "phase" }> =>
						node.kind === "phase",
				)
				.map((node) => [node.key, node]),
		)
		const executions = workNodes.filter(
			(node): node is ExecutionNode => node.kind === "execution-unit",
		)
		const taskOrder = orderedTasks(epics, tasks)
		const phaseOrder = taskOrder.flatMap((task) => orderedPhases(task, phases))
		const executionsFor = (node: EntityNode) => {
			if (node.kind === "phase") {
				const separator = node.key.indexOf("/")
				const taskId = node.key.slice(0, separator)
				const phaseId = node.key.slice(separator + 1)
				return executions.filter(
					(execution) =>
						execution.data.taskId === taskId &&
						"phaseId" in execution.data &&
						execution.data.phaseId === phaseId,
				)
			}
			if (node.kind === "task") {
				return executions.filter(
					(execution) => execution.data.taskId === node.key,
				)
			}
			const taskIds = new Set(node.data.tasks.map((item) => item.id))
			return executions.filter((execution) =>
				taskIds.has(execution.data.taskId),
			)
		}
		const makeRows = (nodes: readonly EntityNode[]) =>
			nodes.map((node) => rowFor(node, executionsFor(node)))
		const filterRows = (rows: readonly WorkViewRow[]) =>
			rows
				.filter((row) => statuses.length === 0 || statuses.includes(row.status))
				.filter(
					(row) =>
						!options.repositories?.length ||
						row.repositories
							.split(",")
							.some((repo) => options.repositories!.includes(repo)),
				)
				.filter((row) => options.ready !== true || row.readiness === "ready")
				.filter(
					(row) => options.blocked !== true || row.readiness === "blocked",
				)
				.filter((row) => options.pr === undefined || row.hasPr === options.pr)

		const epicRows = filterRows(makeRows(epics))
		const taskRows = filterRows(makeRows(taskOrder))
		const phaseRows = filterRows(makeRows(phaseOrder))
		const executionEntities: EntityNode[] = []
		for (const task of taskOrder) {
			const taskPhases = orderedPhases(task, phases)
			executionEntities.push(...(taskPhases.length > 0 ? taskPhases : [task]))
		}
		const executionRows = filterRows(makeRows(executionEntities))

		return { epicRows, taskRows, phaseRows, executionRows }
	})
