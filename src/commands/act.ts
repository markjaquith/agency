import { Effect } from "effect"
import { Schema } from "@effect/schema"
import { ActDiscovery } from "../act-schema"
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
import { scenarios, scenarioOutput } from "./act-scenarios"

type EntityNode = Extract<
	GraphNode,
	{ readonly kind: "epic" | "task" | "phase" }
>

type ActAction = "work" | "pr" | "reopen" | "drop" | "archive"

export interface ActInteraction {
	readonly text?: (prompt: string) => Effect.Effect<string | null, Error>
	readonly select: <T>(
		prompt: string,
		choices: readonly Choice<T>[],
		command?: readonly string[],
	) => Effect.Effect<T | null, Error>
}

interface ActOptions extends BaseCommandOptions {
	readonly action?: string
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
	text: (prompt) =>
		Effect.tryPromise({
			try: async () => {
				try {
					return await (
						await (
							await import("../utils/interactive-loader")
						).loadInteractive()
					).promptText(prompt)
				} catch (cause) {
					if (
						cause instanceof Error &&
						cause.message === "Interactive input cancelled"
					)
						return null
					throw cause
				}
			},
			catch: (cause) => new Error("Failed to read action input", { cause }),
		}),
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

const executionNode = (
	node: EntityNode,
	executions: ReadonlyMap<
		string,
		Extract<GraphNode, { readonly kind: "execution-unit" }>
	>,
): Extract<GraphNode, { readonly kind: "execution-unit" }> | undefined => {
	if (node.kind === "epic") return undefined
	if (node.kind === "task" && "phases" in node.data) return undefined
	return executions.get(node.id)
}

const canWork = (
	node: EntityNode,
	executions: Parameters<typeof executionNode>[1],
) => {
	if (node.kind === "epic" || (node.kind === "task" && "phases" in node.data)) {
		return node.readiness.ready
	}
	const execution = executionNode(node, executions)
	return Boolean(
		execution &&
		(execution.readiness.ready ||
			(execution.status === "working" &&
				execution.readiness.blockers.every(
					(blocker) =>
						blocker.kind !== "validation" && blocker.kind !== "dependency",
				))),
	)
}

const canCreatePr = (
	node: EntityNode,
	executions: Parameters<typeof executionNode>[1],
) => {
	const execution = executionNode(node, executions)
	return Boolean(
		execution &&
		!("review" in execution.data) &&
		!(
			"purpose" in execution.data && execution.data.purpose === "investigation"
		) &&
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
	executions: Parameters<typeof executionNode>[1],
): readonly Choice<ActAction>[] => {
	const choices: Choice<ActAction>[] = []
	const execution = executionNode(node, executions)
	if (canWork(node, executions)) {
		choices.push({ key: "work", label: "Work on this item", value: "work" })
	}
	if (canCreatePr(node, executions)) {
		choices.push({ key: "pr", label: "Create pull request", value: "pr" })
	}
	if (execution && isTerminalStatus(node.status)) {
		choices.push({ key: "reopen", label: "Reopen", value: "reopen" })
	}
	if (execution && !isTerminalStatus(node.status)) {
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
				? [
						"agency",
						"phase",
						"status",
						taskId,
						phaseId,
						status,
						"--if-revision",
						node.data.sha256,
					]
				: [
						"agency",
						"task",
						"status",
						taskId,
						status,
						"--if-revision",
						node.data.sha256,
					]
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
	executions: Parameters<typeof executionNode>[1],
	options: Pick<ActOptions, "auto" | "draft">,
) => ({
	kind: node.kind,
	id: node.id,
	key: node.key,
	status: node.status,
	readiness: node.readiness,
	revision: node.data.sha256,
	actions: [
		...actionChoices(node, executions).map((choice) => ({
			id: choice.value,
			label: choice.label,
			available: true,
			inputs: [],
			command: actionCommand(node, choice.value, options),
		})),
		...itemScenarios(node, executions)
			.filter((scenario) => !scenario.reason)
			.map((scenario) => scenarioOutput(scenario, options.auto)),
	],
	blockedActions: [
		...(["work", "pr", "reopen", "drop", "archive"] as const)
			.filter(
				(id) =>
					!actionChoices(node, executions).some(
						(choice) => choice.value === id,
					),
			)
			.map((id) => ({
				id,
				available: false,
				blockedReason:
					id === "archive"
						? "Item and all children must be terminal"
						: id === "reopen"
							? "Only terminal execution units can reopen"
							: id === "drop"
								? "Requires a nonterminal execution unit"
								: id === "pr"
									? "Requires an eligible implementation unit without a recorded PR or blocking dependencies"
									: node.readiness.blockers
											.map((blocker) => blocker.reason)
											.join("; ") || "Item is not ready for work",
			})),
		...itemScenarios(node, executions)
			.filter((scenario) => scenario.reason)
			.map((scenario) => scenarioOutput(scenario, options.auto)),
	],
})

const itemScenarios = (
	node: EntityNode,
	executions: Parameters<typeof executionNode>[1],
) => {
	const execution = executionNode(node, executions)
	return scenarios(
		node,
		execution && "purpose" in execution.data
			? execution.data.purpose
			: undefined,
	)
}

const executionNodes = (nodes: readonly GraphNode[]) => {
	const taskPurposes = new Map(
		nodes.flatMap((node) =>
			node.kind === "task" && "purpose" in node.data
				? [[node.key, node.data.purpose] as const]
				: [],
		),
	)
	const executions = new Map<
		string,
		Extract<GraphNode, { readonly kind: "execution-unit" }>
	>()
	for (const node of nodes) {
		if (node.kind !== "execution-unit") continue
		const key =
			"phaseId" in node.data
				? `phase:${node.data.taskId}/${node.data.phaseId}`
				: `task:${node.data.taskId}`
		const purpose = taskPurposes.get(node.data.taskId)
		executions.set(
			key,
			purpose ? { ...node, data: { ...node.data, purpose } } : node,
		)
	}
	return executions
}

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
		const graph = yield* graphs.get({
			cwd: root,
			loadedConfig: { root, config },
		})
		const executions = executionNodes(graph.nodes)
		const nodes = graph.nodes.filter(
			(node): node is EntityNode =>
				node.kind === "epic" || node.kind === "task" || node.kind === "phase",
		)

		const requestedKey =
			selectedEntityKey(options) ??
			pathEntityKey(options.directory, isDirectory, root, startPath)
		const globalScenario = scenarios().find(
			(scenario) => scenario.id === options.action,
		)
		if (
			options.action &&
			!globalScenario &&
			![
				"work",
				"pr",
				"reopen",
				"drop",
				"archive",
				...scenarios(undefined, undefined, true).map((scenario) => scenario.id),
			].includes(options.action)
		) {
			return yield* Effect.fail(
				new Error(
					`Unknown action '${options.action}'; use agency act --json to discover actions`,
				),
			)
		}
		if (requestedKey && globalScenario)
			return yield* Effect.fail(
				new Error("Workbase actions do not accept an item selector"),
			)
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
					yield* Schema.decodeUnknown(ActDiscovery)({
						workbase: {
							root,
							repositories: graph.nodes
								.filter((node) => node.kind === "repository")
								.map((node) => node.key),
							actions: scenarios()
								.filter(
									(scenario) =>
										!options.action || scenario.id === options.action,
								)
								.map((scenario) => scenarioOutput(scenario, options.auto)),
						},
						currentWork: nodes
							.filter((node) => node.status === "working")
							.map((node) => ({
								kind: node.kind,
								key: node.key,
								description:
									"description" in node.data
										? node.data.description
										: undefined,
								repositories: node.repositories,
								readiness: node.readiness,
							})),
						targets: globalScenario
							? []
							: matchingNodes.map((node) => {
									const target = targetOutput(node, executions, options)
									return {
										...target,
										actions: target.actions.filter(
											(action) =>
												!options.action || action.id === options.action,
										),
										blockedActions: target.blockedActions.filter(
											(action) =>
												!options.action || action.id === options.action,
										),
									}
								}),
					}),
					null,
					2,
				),
			)
			return
		}

		const guided = (
			scenario: ReturnType<typeof scenarios>[number],
			selected?: EntityNode,
		) =>
			Effect.gen(function* () {
				if (scenario.reason)
					return yield* Effect.fail(new Error(scenario.reason))
				const values: Record<string, string> = {}
				for (const field of scenario.inputs) {
					const slugSource =
						"slugFrom" in field ? values[field.slugFrom!] : undefined
					let suggested = slugSource
						? slugSource
								.toLowerCase()
								.replace(/^https?:\/\/(?:www\.)?github\.com\//, "review-")
								.replace(/[^a-z0-9]+/g, "-")
								.replace(/^-|-$/g, "")
								.slice(0, 60)
						: field.default
					if ("defaultTemplate" in field)
						suggested = field.defaultTemplate!.replace(
							/<([^>]+)>/g,
							(_match, key: string) => values[key] ?? "",
						)
					if (field.id === "id" && suggested) {
						suggested = suggested
							.toLowerCase()
							.replace(/[^a-z0-9-]+/g, "-")
							.replace(/^-+|-+$/g, "")
							.slice(0, 60)
						const prefix = scenario.id === "split" ? `${selected!.key}/` : ""
						const base = suggested
						let suffix = 2
						while (nodes.some((node) => node.key === `${prefix}${suggested}`))
							suggested = `${base}-${suffix++}`
					}
					const repositoryChoices =
						field.id === "repo"
							? graph.nodes
									.filter((node) => node.kind === "repository")
									.map((node) => node.key)
							: []
					const choices =
						"choices" in field
							? field.choices
							: repositoryChoices.length
								? repositoryChoices
								: undefined
					const answer =
						field.id === "repo" && choices?.length === 1
							? choices[0]!
							: choices?.length
								? yield* interaction.select(
										field.label,
										choices.map((value) => ({
											key: value,
											label: value,
											value,
										})),
										config.chooserCommand,
									)
								: yield* (interaction.text ?? defaultInteraction.text!)(
										`${field.label}${suggested ? ` [${suggested}]` : ""}: `,
									)
					if (answer === null) return
					values[field.id] = answer.trim() || suggested || ""
					if (field.required && !values[field.id])
						return yield* Effect.fail(new Error(`${field.label} is required`))
				}
				if (selected) {
					const fresh = yield* graphs.get({ cwd: root })
					const current = fresh.nodes.find((node) => node.id === selected.id)
					if (
						!current ||
						(current.kind !== "task" &&
							current.kind !== "phase" &&
							current.kind !== "epic") ||
						current.data.sha256 !== selected.data.sha256 ||
						!itemScenarios(current, executionNodes(fresh.nodes)).some(
							(candidate) => candidate.id === scenario.id && !candidate.reason,
						)
					)
						return yield* Effect.fail(
							new Error("Selected work item changed; run agency act again"),
						)
				}
				if (options.dryRun) {
					log(shellCommand(scenario.command(values)))
					if ("followUpCommands" in scenario)
						for (const command of scenario.followUpCommands)
							log(shellCommand(command))
					return
				}
				yield* scenario.run(values, { ...options, cwd: root })
				if ("nextTarget" in scenario && scenario.nextTarget) {
					const next = scenario.nextTarget(values)
					const followUp = yield* interaction.select(
						"Created. What next?",
						[
							{
								key: "finish",
								label: "Finish — keep this item for later",
								value: "finish",
							},
							{ key: "work", label: "Work on the new item now", value: "work" },
						],
						config.chooserCommand,
					)
					if (followUp === "work")
						yield* work({
							...next,
							cwd: root,
							auto: options.auto,
							inputAllowed: options.inputAllowed,
							silent: options.silent,
							verbose: options.verbose,
						})
				}
			})
		const selectableNodes = nodes.filter(
			(node) =>
				actionChoices(node, executions).length > 0 ||
				itemScenarios(node, executions).some((scenario) => !scenario.reason),
		)
		const firstChoices: Choice<string>[] = [
			...scenarios().map((scenario) => ({
				key: scenario.id,
				label: scenario.label,
				value: `scenario:${scenario.id}`,
			})),
			...Array.from(
				new Map(
					nodes.flatMap((node) => [
						...actionChoices(node, executions).map(
							(choice) => [choice.value, choice.label] as const,
						),
						...itemScenarios(node, executions)
							.filter((scenario) => !scenario.reason)
							.map((scenario) => [scenario.id, scenario.label] as const),
					]),
				).entries(),
			).map(([id, label]) => ({
				key: `action:${id}`,
				label,
				value: `action:${id}`,
			})),
			...entityChoices(selectableNodes, graph.edges),
		]
		let selectedKey =
			requestedKey ??
			(options.action
				? `${globalScenario ? "scenario" : "action"}:${options.action}`
				: undefined) ??
			(yield* interaction.select(
				"What would you like to do? (or select an item)",
				firstChoices,
				config.chooserCommand,
			))
		if (selectedKey === null) return
		if (selectedKey.startsWith("scenario:")) {
			const scenario = scenarios().find(
				(scenario) => `scenario:${scenario.id}` === selectedKey,
			)
			if (scenario) yield* guided(scenario)
			return
		}
		let requestedAction: string | undefined = options.action
		if (selectedKey.startsWith("action:")) {
			requestedAction = selectedKey.slice(7)
			selectedKey = yield* interaction.select(
				"Choose an item",
				entityChoices(
					nodes.filter(
						(node) =>
							actionChoices(node, executions).some(
								(choice) => choice.value === requestedAction,
							) ||
							itemScenarios(node, executions).some(
								(scenario) =>
									scenario.id === requestedAction && !scenario.reason,
							),
					),
					graph.edges,
				),
				config.chooserCommand,
			)
			if (selectedKey === null) return
		}
		const selected = nodes.find((node) => entityKey(node) === selectedKey)
		if (!selected) {
			return yield* Effect.fail(
				new Error("Selected work item is no longer available"),
			)
		}
		const offeredActions: Choice<string>[] = [
			...actionChoices(selected, executions),
			...itemScenarios(selected, executions)
				.filter((scenario) => !scenario.reason)
				.map((scenario) => ({
					key: scenario.id,
					label: scenario.label,
					value: scenario.id,
				})),
		]
		if (
			requestedAction &&
			!offeredActions.some((choice) => choice.value === requestedAction)
		)
			return yield* Effect.fail(
				new Error(
					`Action '${requestedAction}' is unavailable for ${selected.key}; use agency act --task ${entityParts(selected).taskId} --json for blocked reasons`,
				),
			)
		if (offeredActions.length === 0) {
			return yield* Effect.fail(
				new Error(
					`No actions are currently available for ${selected.kind} '${selected.key}'`,
				),
			)
		}
		const action =
			requestedAction ??
			(yield* interaction.select(
				`Act on ${selected.kind} ${selected.key}`,
				offeredActions,
				config.chooserCommand,
			))
		if (action === null) return
		const scenario = itemScenarios(selected, executions).find(
			(scenario) => scenario.id === action,
		)
		if (scenario) {
			yield* guided(scenario, selected)
			return
		}

		const refreshed = yield* graphs.get({ cwd: root })
		const refreshedExecutions = executionNodes(refreshed.nodes)
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
			!sameActions(
				actionChoices(selected, executions),
				actionChoices(current, refreshedExecutions),
			)
		) {
			return yield* Effect.fail(
				new Error("Selected work item changed; run agency act again"),
			)
		}
		const { taskId, phaseId } = entityParts(current)
		if (options.dryRun) {
			log(shellCommand(actionCommand(current, action as ActAction, options)))
			return
		}

		switch (action) {
			case "work":
				yield* work({
					...(current.kind === "epic"
						? { epicId: current.key }
						: { taskId, ...(phaseId ? { phaseId } : {}) }),
					auto: options.auto,
					cwd: root,
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
					cwd: root,
					silent: options.silent,
					verbose: options.verbose,
				})
				return
			case "reopen":
				if (phaseId) {
					yield* phaseCommand({
						subcommand: "status",
						args: [taskId, phaseId, "open"],
						ifRevision: current.data.sha256,
						cwd: root,
						silent: options.silent,
						verbose: options.verbose,
					})
				} else {
					yield* taskCommand({
						subcommand: "status",
						args: [taskId, "open"],
						ifRevision: current.data.sha256,
						cwd: root,
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
						ifRevision: current.data.sha256,
						cwd: root,
						silent: options.silent,
						verbose: options.verbose,
					})
				} else {
					yield* taskCommand({
						subcommand: "status",
						args: [taskId, "dropped"],
						ifRevision: current.data.sha256,
						cwd: root,
						silent: options.silent,
						verbose: options.verbose,
					})
				}
				return
			case "archive":
				yield* archiveCommand({
					type: current.kind,
					args: current.kind === "phase" ? [taskId, phaseId!] : [current.key],
					cwd: root,
					silent: options.silent,
					verbose: options.verbose,
				})
		}
	})

export const help = `
Usage: agency act [<directory-or-task-id> | --epic <id> | --task <id> [--phase <id>]] [--action <id>] [--dry-run | --json] [--auto] [--draft]

Choose a scenario or an item: create, split, work, review, hand off, close,
refresh PR state, archive, or inspect current work. Guided creation offers an
explicit Work choice afterward. Creation alone never starts work.
An existing positional directory selects its containing epic, task, or phase;
otherwise the positional value is a task ID. Selectors skip work-item selection.
--dry-run prints the selected action's exact
Agency command without executing it. --json lists targets, available actions,
blocked reasons, required inputs, and command argv/templates without prompting
or executing. --action narrows discovery or starts a specific guided scenario.

Options:
	--action <id>         Select a scenario (discover IDs with --json)
	--epic <id>           Select an epic
	--task <id>           Select a task
	--phase <id>          Select a phase; requires --task
	--dry-run             Select an action and print its command without executing
	--json                List available actions and command argv as JSON
  --auto                Pass --auto when starting or continuing work
  --draft               Create a draft pull request
`
