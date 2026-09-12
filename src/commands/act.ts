import { Schema } from "@effect/schema"
import { Effect } from "effect"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { ActDiscovery } from "../act-schema"
import type { GraphEdge } from "../graph-schema"
import { FileSystemService } from "../services/FileSystemService"
import { GraphService } from "../services/GraphService"
import { WorkbaseService } from "../services/WorkbaseService"
import type { BaseCommandOptions } from "../utils/command"
import type { Choice } from "../utils/chooser"
import { createLoggers } from "../utils/effect"
import {
	actionGroups,
	actActions,
	actionOutput,
	type ActAction,
	type ActEntity,
} from "./act-actions"
import {
	ActCancelled,
	actionPrompts,
	defaultInteraction,
	type ActInteraction,
} from "./act-prompts"
import { work as startWork, type StartWork } from "./work"

export type { ActInteraction } from "./act-prompts"

interface ActOptions extends BaseCommandOptions {
	readonly action?: string
	readonly directory?: string
	readonly auto?: boolean
	readonly draft?: boolean
	readonly dryRun?: boolean
	readonly epicId?: string
	readonly taskId?: string
	readonly phaseId?: string
}

const entityChoices = (
	nodes: readonly ActEntity[],
	edges: readonly GraphEdge[],
): Choice<string>[] => {
	const byId = new Map(nodes.map((node) => [node.id, node]))
	const children = new Map<string, ActEntity[]>()
	const owned = new Set<string>()
	for (const edge of edges) {
		const child = byId.get(edge.to)
		if (edge.kind !== "owns" || !byId.has(edge.from) || !child) continue
		children.set(edge.from, [...(children.get(edge.from) ?? []), child])
		owned.add(child.id)
	}
	const choices: Choice<string>[] = []
	const append = (node: ActEntity, depth: number) => {
		const description =
			"description" in node.data ? node.data.description : undefined
		choices.push({
			key: node.id,
			value: node.id,
			depth,
			label: `[${node.status}] ${node.kind} ${node.key}${description ? ` - ${description}` : ""}`,
		})
		for (const child of children.get(node.id) ?? []) append(child, depth + 1)
	}
	for (const node of nodes) if (!owned.has(node.id)) append(node, 0)
	return choices
}

const pathEntityKey = (root: string, path: string) => {
	const local = relative(root, path)
	const parts =
		!local || isAbsolute(local) || local.startsWith(`..${sep}`)
			? []
			: local.split(sep)
	if (parts[0] === "epics" && parts[1]) return `epic:${parts[1]}`
	if (parts[0] !== "tasks" || !parts[1]) return undefined
	return parts[2] === "phases" && parts[3]
		? `phase:${parts[1]}/${parts[3]}`
		: `task:${parts[1]}`
}
const shellCommand = (argv: readonly string[]) =>
	argv
		.map((arg) =>
			/^[A-Za-z0-9_./:=+@%-]+$/.test(arg)
				? arg
				: `'${arg.replaceAll("'", `'\\''`)}'`,
		)
		.join(" ")
const available = (action: ActAction) => !action.blockedReason
const actionChoices = (actions: readonly ActAction[]): Choice<string>[] =>
	actions.map(({ id, label }) => ({ key: id, label, value: id }))

export const act = (
	options: ActOptions = {},
	interaction: ActInteraction = defaultInteraction,
	work: StartWork = startWork,
) =>
	Effect.gen(function* () {
		if (!options.json && options.inputAllowed === false)
			return yield* Effect.fail(
				new Error(
					"agency act requires interactive input; use --json to list actions for automation",
				),
			)
		const fs = yield* FileSystemService
		const workbase = yield* WorkbaseService
		const graphs = yield* GraphService
		const { log } = createLoggers(options)
		const cwd = options.cwd ?? process.cwd()
		const path = resolve(cwd, options.directory ?? ".")
		const isDirectory = yield* fs.isDirectory(path)
		const { root, config } = yield* workbase.loadConfig(
			isDirectory ? path : cwd,
		)
		const graph = yield* graphs.get({
			cwd: root,
			loadedConfig: { root, config },
		})
		const nodes = graph.nodes.filter(
			(node): node is ActEntity =>
				node.kind === "epic" || node.kind === "task" || node.kind === "phase",
		)
		const nativeOptions = {
			cwd: root,
			auto: options.auto,
			draft: options.draft,
			inputAllowed: options.inputAllowed,
			silent: options.silent,
			verbose: options.verbose,
		}
		const globals = actActions(graph.nodes, nativeOptions, work)
		const catalog = new Map(
			nodes.map((node) => [
				node.id,
				actActions(graph.nodes, nativeOptions, work, node),
			]),
		)
		let selectedKey = options.epicId
			? `epic:${options.epicId}`
			: options.phaseId
				? `phase:${options.taskId}/${options.phaseId}`
				: options.taskId
					? `task:${options.taskId}`
					: options.directory
						? isDirectory
							? pathEntityKey(root, path)
							: `task:${options.directory}`
						: undefined
		let actionId = options.action
		if (
			actionId &&
			!actionGroups.some((group) => group.actions.some((id) => id === actionId))
		)
			return yield* Effect.fail(
				new Error(
					`Unknown action '${actionId}'; use agency act --json to discover actions`,
				),
			)
		const globalAction = globals.find((action) => action.id === actionId)
		if (selectedKey && globalAction)
			return yield* Effect.fail(
				new Error("Workbase actions do not accept an item selector"),
			)
		if (selectedKey && !catalog.has(selectedKey))
			return yield* Effect.fail(
				new Error(`Selected work item '${selectedKey}' was not found`),
			)
		if (options.json) {
			const matches = (action: ActAction) => !actionId || action.id === actionId
			log(
				JSON.stringify(
					yield* Schema.decodeUnknown(ActDiscovery)({
						workbase: {
							root,
							repositories: graph.nodes
								.filter((node) => node.kind === "repository")
								.map((node) => node.key),
							actions: globals
								.filter(matches)
								.map((action) => actionOutput(action, options.auto)),
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
						targets: globalAction
							? []
							: nodes
									.filter((node) => !selectedKey || node.id === selectedKey)
									.map((node) => {
										const actions = catalog.get(node.id)!.filter(matches)
										return {
											kind: node.kind,
											id: node.id,
											key: node.key,
											status: node.status,
											readiness: node.readiness,
											revision: node.data.sha256,
											actions: actions
												.filter(available)
												.map((action) => actionOutput(action, options.auto)),
											blockedActions: actions
												.filter((action) => !available(action))
												.map((action) => actionOutput(action, options.auto)),
										}
									}),
					}),
					null,
					2,
				),
			)
			return
		}
		const select = <T>(prompt: string, choices: readonly Choice<T>[]) =>
			Effect.gen(function* () {
				const answer = yield* interaction.select(
					prompt,
					choices,
					config.chooserCommand,
				)
				if (answer === null) return yield* Effect.fail(new ActCancelled())
				return answer
			})
		if (!selectedKey && !actionId) {
			const goal = yield* select("What would you like to do?", [
				...actionGroups.map(({ id, label }) => ({ key: id, label, value: id })),
				{ key: "browse", label: "Browse items", value: "browse" },
			])
			if (goal === "browse") {
				if (!nodes.length)
					return yield* Effect.fail(
						new Error("No work items yet; choose Create a task first"),
					)
				selectedKey = yield* select(
					"Choose an item",
					entityChoices(nodes, graph.edges),
				)
			} else {
				const group = actionGroups.find((group) => group.id === goal)!
				const all = [...globals, ...Array.from(catalog.values()).flat()]
				const choices = group.actions.flatMap((id) => {
					const action = all.find((action) => action.id === id)
					return action ? [action] : []
				})
				if (!choices.length)
					return yield* Effect.fail(
						new Error("No work items yet; choose Create a task first"),
					)
				actionId =
					choices.length === 1
						? choices[0]!.id
						: yield* select(group.label, actionChoices(choices))
			}
		}
		if (
			!selectedKey &&
			actionId &&
			!globals.some((action) => action.id === actionId)
		) {
			const eligible = nodes.filter((node) =>
				catalog
					.get(node.id)!
					.some((action) => action.id === actionId && available(action)),
			)
			if (!eligible.length)
				return yield* Effect.fail(
					new Error(
						`No eligible items for '${actionId}'; use agency act --action ${actionId} --json for blocked reasons`,
					),
				)
			selectedKey = yield* select(
				"Choose an item",
				entityChoices(eligible, graph.edges),
			)
		}
		const selected = nodes.find((node) => node.id === selectedKey)
		const actions = selected ? catalog.get(selected.id)! : globals
		if (!actionId)
			actionId = yield* select(
				`Act on ${selected!.kind} ${selected!.key}`,
				actionChoices(actions.filter(available)),
			)
		const action = actions.find((action) => action.id === actionId)
		if (!action || action.blockedReason)
			return yield* Effect.fail(
				new Error(
					`Action '${actionId}' is unavailable: ${action?.blockedReason ?? "not found"}`,
				),
			)
		const prompts = actionPrompts(
			interaction,
			graph.nodes
				.filter((node) => node.kind === "repository")
				.map((node) => node.key),
			nodes.map((node) => node.key),
			config.chooserCommand,
		)
		const plan = yield* action.prepare(prompts)
		if (selected) {
			const fresh = yield* graphs.get({ cwd: root })
			const current = fresh.nodes.find(
				(node): node is ActEntity =>
					node.id === selected.id &&
					(node.kind === "task" ||
						node.kind === "phase" ||
						node.kind === "epic"),
			)
			if (
				!current ||
				current.data.sha256 !== selected.data.sha256 ||
				!actActions(fresh.nodes, nativeOptions, work, current).some(
					(candidate) => candidate.id === actionId && available(candidate),
				)
			)
				return yield* Effect.fail(
					new Error("Selected work item changed; run agency act again"),
				)
		}
		if (options.dryRun) {
			for (const command of [plan.command, ...(plan.followUpCommands ?? [])])
				log(shellCommand(command))
			return
		}
		yield* plan.run
		if (plan.next) {
			const next = yield* select("Created. What next?", [
				{
					key: "finish",
					label: "Finish — keep this item for later",
					value: "finish",
				},
				{ key: "work", label: "Work on the new item now", value: "work" },
			])
			if (next === "work") yield* work({ ...nativeOptions, ...plan.next })
		}
	}).pipe(
		Effect.catchAll((error) =>
			error instanceof ActCancelled ? Effect.void : Effect.fail(error),
		),
	)

export const help = `
Usage: agency act [<directory-or-task-id> | --epic <id> | --task <id> [--phase <id>]] [--action <id>] [--dry-run | --json] [--auto] [--draft]

Choose a goal, or Browse items to start with existing work. Guided creation
offers an explicit Work choice afterward; creation alone never starts work.
An existing directory selects its containing epic, task, or phase; otherwise
the positional value is a task ID. Selectors skip item selection.

Options:
  --action <id>         Start an action or filter discovery (IDs from --json)
  --epic <id>           Select an epic
  --task <id>           Select a task
  --phase <id>          Select a phase; requires --task
  --dry-run             Collect inputs and print commands without executing
  --json                Discover actions, required inputs, argv, and blocked reasons
  --auto                Pass --auto when starting or continuing work
  --draft               Create a draft pull request
`
