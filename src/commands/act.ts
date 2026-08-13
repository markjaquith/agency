import { Effect } from "effect"
import { isAbsolute, relative, resolve, sep } from "node:path"
import type { GraphNode } from "../graph-schema"
import { isTerminalStatus } from "../readiness"
import { FileSystemService } from "../services/FileSystemService"
import { GraphService } from "../services/GraphService"
import { WorkbaseService } from "../services/WorkbaseService"
import type { BaseCommandOptions } from "../utils/command"
import { choose, type Choice } from "../utils/chooser"
import { createLoggers } from "../utils/effect"
import { macchiato } from "../utils/theme"
import { archive as archiveCommand } from "./archive"
import { phase as phaseCommand } from "./phase"
import { prCreate as createPullRequest } from "./pr"
import { task as taskCommand } from "./task"
import { work as startWork, type StartWork } from "./work"

type EntityNode = Extract<
	GraphNode,
	{ readonly kind: "epic" | "task" | "phase" }
>

type ActAction = "work" | "pr" | "reopen" | "drop" | "archive"

export interface ActInteraction {
	readonly select: <T>(
		prompt: string,
		choices: readonly Choice<T>[],
		command?: readonly string[],
	) => Effect.Effect<T | null, Error>
}

interface ActOptions extends BaseCommandOptions {
	readonly directory?: string
	readonly auto?: boolean
	readonly draft?: boolean
	readonly dryRun?: boolean
	readonly json?: boolean
	readonly epicId?: string
	readonly taskId?: string
	readonly phaseId?: string
}

const defaultInteraction: ActInteraction = {
	select: (prompt, choices, command) => choose(prompt, choices, command),
}

const entityKey = (node: EntityNode) => `${node.kind}:${node.key}`

const entityDescription = (node: EntityNode) =>
	"description" in node.data && node.data.description
		? ` - ${node.data.description}`
		: ""

const orderedEntities = (
	nodes: readonly EntityNode[],
	edges: readonly {
		readonly kind: string
		readonly from: string
		readonly to: string
	}[],
) => {
	const byId = new Map(nodes.map((node) => [node.id, node]))
	const children = new Map<string, EntityNode[]>()
	const owned = new Set<string>()
	for (const edge of edges) {
		if (edge.kind !== "owns") continue
		const parent = byId.get(edge.from)
		const child = byId.get(edge.to)
		if (!parent || !child) continue
		children.set(edge.from, [...(children.get(edge.from) ?? []), child])
		owned.add(child.id)
	}

	const ordered: { readonly node: EntityNode; readonly depth: number }[] = []
	const append = (node: EntityNode, depth: number) => {
		ordered.push({ node, depth })
		for (const child of children.get(node.id) ?? []) append(child, depth + 1)
	}
	for (const node of nodes) {
		if (!owned.has(node.id)) append(node, 0)
	}
	return ordered
}

const entityChoices = (
	nodes: readonly EntityNode[],
	edges: readonly {
		readonly kind: string
		readonly from: string
		readonly to: string
	}[],
): readonly Choice<string>[] =>
	orderedEntities(nodes, edges).map(({ node, depth }, index) => ({
		key: String(index),
		label: `[${node.status}] ${node.kind} ${node.key}${entityDescription(node)}`,
		depth,
		segments: [
			{ text: `[${node.status}] `, color: macchiato.overlay1 },
			{ text: `${node.kind} `, color: macchiato.sapphire },
			{ text: node.key },
			...(entityDescription(node)
				? [{ text: entityDescription(node), color: macchiato.overlay0 }]
				: []),
		],
		value: entityKey(node),
	}))

const activeClaim = (node: EntityNode) =>
	"claim" in node.data && node.data.claim?.state === "active"

const executionNode = (
	node: EntityNode,
	nodes: readonly GraphNode[],
): Extract<GraphNode, { readonly kind: "execution-unit" }> | undefined => {
	if (node.kind === "epic") return undefined
	if (node.kind === "task" && "phases" in node.data) return undefined
	const phaseId =
		node.kind === "phase"
			? node.key.slice(node.key.indexOf("/") + 1)
			: undefined
	return nodes.find(
		(
			candidate,
		): candidate is Extract<GraphNode, { readonly kind: "execution-unit" }> =>
			candidate.kind === "execution-unit" &&
			candidate.data.taskId ===
				(node.kind === "task" ? node.key : node.key.split("/", 1)[0]) &&
			(node.kind === "task" ||
				("phaseId" in candidate.data && candidate.data.phaseId === phaseId)),
	)
}

const canWork = (node: EntityNode, nodes: readonly GraphNode[]) => {
	if (node.kind === "epic" || (node.kind === "task" && "phases" in node.data)) {
		return node.readiness.ready
	}
	const execution = executionNode(node, nodes)
	return Boolean(
		execution &&
		!activeClaim(node) &&
		(execution.readiness.ready ||
			(execution.status === "working" &&
				execution.readiness.blockers.every(
					(blocker) => blocker.kind !== "validation",
				))),
	)
}

const canCreatePr = (node: EntityNode, nodes: readonly GraphNode[]) => {
	const execution = executionNode(node, nodes)
	return Boolean(
		execution &&
		!execution.readiness.terminal &&
		!("pr" in execution.data && execution.data.pr) &&
		!execution.readiness.blockers.some(
			(blocker) =>
				blocker.kind === "dependency" || blocker.kind === "validation",
		),
	)
}

const actionChoices = (
	node: EntityNode,
	nodes: readonly GraphNode[],
): readonly Choice<ActAction>[] => {
	const choices: Choice<ActAction>[] = []
	const execution = executionNode(node, nodes)
	if (canWork(node, nodes)) {
		choices.push({ key: "work", label: "Work on this item", value: "work" })
	}
	if (canCreatePr(node, nodes)) {
		choices.push({ key: "pr", label: "Create pull request", value: "pr" })
	}
	if (execution && isTerminalStatus(node.status) && !activeClaim(node)) {
		choices.push({ key: "reopen", label: "Reopen", value: "reopen" })
	}
	if (execution && !isTerminalStatus(node.status) && !activeClaim(node)) {
		choices.push({ key: "drop", label: "Drop", value: "drop" })
	}
	if (node.readiness.terminal) {
		choices.push({ key: "archive", label: "Archive", value: "archive" })
	}
	return choices
}

const entityParts = (node: EntityNode) => {
	if (node.kind !== "phase") return { taskId: node.key }
	const separator = node.key.indexOf("/")
	return {
		taskId: node.key.slice(0, separator),
		phaseId: node.key.slice(separator + 1),
	}
}

const actionCommand = (
	node: EntityNode,
	action: ActAction,
	options: Pick<ActOptions, "auto" | "draft">,
): readonly string[] => {
	const { taskId, phaseId } = entityParts(node)
	switch (action) {
		case "work":
			return [
				"agency",
				"work",
				...(node.kind === "epic"
					? ["--epic", node.key]
					: ["--task", taskId, ...(phaseId ? ["--phase", phaseId] : [])]),
				...(options.auto ? ["--auto"] : []),
			]
		case "pr":
			return [
				"agency",
				"pr",
				"create",
				taskId,
				...(phaseId ? [phaseId] : []),
				...(options.draft ? ["--draft"] : []),
			]
		case "reopen":
		case "drop": {
			const status = action === "reopen" ? "open" : "dropped"
			return phaseId
				? ["agency", "phase", "status", taskId, phaseId, status]
				: ["agency", "task", "status", taskId, status]
		}
		case "archive":
			return node.kind === "phase"
				? ["agency", "archive", "phase", taskId, phaseId!]
				: ["agency", "archive", node.kind, node.key]
	}
}

const shellCommand = (command: readonly string[]) =>
	command
		.map((argument) =>
			/^[A-Za-z0-9_./:=+@%-]+$/.test(argument)
				? argument
				: `'${argument.replaceAll("'", `'\\''`)}'`,
		)
		.join(" ")

const targetOutput = (
	node: EntityNode,
	nodes: readonly GraphNode[],
	options: Pick<ActOptions, "auto" | "draft">,
) => ({
	kind: node.kind,
	id: node.id,
	key: node.key,
	status: node.status,
	readiness: node.readiness,
	revision: node.data.sha256,
	actions: actionChoices(node, nodes).map((choice) => ({
		id: choice.value,
		label: choice.label,
		command: actionCommand(node, choice.value, options),
	})),
})

const selectedEntityKey = (options: ActOptions) =>
	options.epicId
		? `epic:${options.epicId}`
		: options.phaseId
			? `phase:${options.taskId}/${options.phaseId}`
			: options.taskId
				? `task:${options.taskId}`
				: undefined

const pathEntityKey = (
	directory: string | undefined,
	isDirectory: boolean,
	root: string,
	startPath: string,
) => {
	if (!directory) return undefined
	if (!isDirectory) return `task:${directory}`
	const path = relative(root, startPath)
	const parts =
		!path || isAbsolute(path) || path.startsWith(`..${sep}`)
			? []
			: path.split(sep)
	if (parts[0] === "epics" && parts[1]) return `epic:${parts[1]}`
	if (parts[0] !== "tasks" || !parts[1]) return undefined
	return parts[2] === "phases" && parts[3]
		? `phase:${parts[1]}/${parts[3]}`
		: `task:${parts[1]}`
}

const sameActions = (
	left: readonly Choice<ActAction>[],
	right: readonly Choice<ActAction>[],
) =>
	left.map((choice) => choice.value).join("\0") ===
	right.map((choice) => choice.value).join("\0")

export const act = (
	options: ActOptions = {},
	interaction: ActInteraction = defaultInteraction,
	work: StartWork = startWork,
) =>
	Effect.gen(function* () {
		if (!options.json && options.inputAllowed === false) {
			return yield* Effect.fail(
				new Error(
					"agency act requires interactive input; use --json to list actions for automation",
				),
			)
		}
		const cwd = options.cwd ?? process.cwd()
		const fs = yield* FileSystemService
		const workbase = yield* WorkbaseService
		const graphs = yield* GraphService
		const { log } = createLoggers(options)
		const directoryPath = options.directory
			? resolve(cwd, options.directory)
			: undefined
		const isDirectory = directoryPath
			? yield* fs.isDirectory(directoryPath)
			: false
		const startPath = isDirectory && directoryPath ? directoryPath : cwd
		const { root, config } = yield* workbase.loadConfig(startPath)
		const graph = yield* graphs.get({ cwd: root })
		const nodes = graph.nodes.filter(
			(node): node is EntityNode =>
				node.kind === "epic" || node.kind === "task" || node.kind === "phase",
		)
		if (nodes.length === 0) {
			if (options.json) {
				log(JSON.stringify({ targets: [] }, null, 2))
				return
			}
			return yield* Effect.fail(
				new Error("No active work items found in this workbase"),
			)
		}

		const requestedKey =
			selectedEntityKey(options) ??
			pathEntityKey(options.directory, isDirectory, root, startPath)
		const matchingNodes = requestedKey
			? nodes.filter((node) => entityKey(node) === requestedKey)
			: nodes
		if (requestedKey && matchingNodes.length === 0) {
			return yield* Effect.fail(
				new Error(`Selected work item '${requestedKey}' was not found`),
			)
		}
		if (options.json) {
			log(
				JSON.stringify(
					{
						targets: matchingNodes.map((node) =>
							targetOutput(node, graph.nodes, options),
						),
					},
					null,
					2,
				),
			)
			return
		}

		const selectableNodes = nodes.filter(
			(node) => actionChoices(node, graph.nodes).length > 0,
		)
		if (!requestedKey && selectableNodes.length === 0) {
			return yield* Effect.fail(
				new Error(
					"No work items with available actions found in this workbase",
				),
			)
		}
		const selectedKey =
			requestedKey ??
			(yield* interaction.select(
				"Act on",
				entityChoices(selectableNodes, graph.edges),
				config.chooserCommand,
			))
		if (selectedKey === null) return
		const selected = nodes.find((node) => entityKey(node) === selectedKey)
		if (!selected) {
			return yield* Effect.fail(
				new Error("Selected work item is no longer available"),
			)
		}
		const offeredActions = actionChoices(selected, graph.nodes)
		if (offeredActions.length === 0) {
			return yield* Effect.fail(
				new Error(
					`No actions are currently available for ${selected.kind} '${selected.key}'`,
				),
			)
		}
		const action = yield* interaction.select(
			`Act on ${selected.kind} ${selected.key}`,
			offeredActions,
			config.chooserCommand,
		)
		if (action === null) return

		const refreshed = yield* graphs.get({ cwd })
		const current = refreshed.nodes.find(
			(node): node is EntityNode =>
				(node.kind === "epic" ||
					node.kind === "task" ||
					node.kind === "phase") &&
				entityKey(node) === selectedKey,
		)
		if (!current) {
			return yield* Effect.fail(
				new Error(
					"Selected work item changed or was removed; run agency act again",
				),
			)
		}
		if (
			current.data.sha256 !== selected.data.sha256 ||
			!sameActions(offeredActions, actionChoices(current, refreshed.nodes))
		) {
			return yield* Effect.fail(
				new Error("Selected work item changed; run agency act again"),
			)
		}
		const { taskId, phaseId } = entityParts(current)
		if (options.dryRun) {
			log(shellCommand(actionCommand(current, action, options)))
			return
		}

		switch (action) {
			case "work":
				yield* work({
					...(current.kind === "epic"
						? { epicId: current.key }
						: { taskId, ...(phaseId ? { phaseId } : {}) }),
					auto: options.auto,
					cwd,
					inputAllowed: options.inputAllowed,
					silent: options.silent,
					verbose: options.verbose,
				})
				return
			case "pr":
				yield* createPullRequest({
					taskId,
					phaseId,
					draft: options.draft,
					cwd,
					silent: options.silent,
					verbose: options.verbose,
				})
				return
			case "reopen":
				if (phaseId) {
					yield* phaseCommand({
						subcommand: "status",
						args: [taskId, phaseId, "open"],
						cwd,
						silent: options.silent,
						verbose: options.verbose,
					})
				} else {
					yield* taskCommand({
						subcommand: "status",
						args: [taskId, "open"],
						cwd,
						silent: options.silent,
						verbose: options.verbose,
					})
				}
				return
			case "drop":
				if (phaseId) {
					yield* phaseCommand({
						subcommand: "status",
						args: [taskId, phaseId, "dropped"],
						cwd,
						silent: options.silent,
						verbose: options.verbose,
					})
				} else {
					yield* taskCommand({
						subcommand: "status",
						args: [taskId, "dropped"],
						cwd,
						silent: options.silent,
						verbose: options.verbose,
					})
				}
				return
			case "archive":
				yield* archiveCommand({
					type: current.kind,
					args: current.kind === "phase" ? [taskId, phaseId!] : [current.key],
					cwd,
					silent: options.silent,
					verbose: options.verbose,
				})
		}
	})

export const help = `
Usage: agency act [<directory-or-task-id> | --epic <id> | --task <id> [--phase <id>]] [--dry-run | --json] [--auto] [--draft]

Interactively choose an active work item and a state-aware lifecycle action.
An existing positional directory selects its containing epic, task, or phase;
otherwise the positional value is a task ID. Selectors skip work-item selection.
--dry-run prints the selected action's exact
Agency command without executing it. --json lists targets, available actions,
and command argv without prompting or executing.

Options:
	--epic <id>           Select an epic
	--task <id>           Select a task
	--phase <id>          Select a phase; requires --task
	--dry-run             Select an action and print its command without executing
	--json                List available actions and command argv as JSON
  --auto                Pass --auto when starting or continuing work
  --draft               Create a draft pull request
`
