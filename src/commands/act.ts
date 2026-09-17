import { Schema } from "@effect/schema"
import { Effect } from "effect"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { ActDiscovery } from "../act-schema"
import { FileSystemService } from "../services/FileSystemService"
import { GraphService } from "../services/GraphService"
import { WorkbaseService } from "../services/WorkbaseService"
import { WorktreeService } from "../services/WorktreeService"
import type { BaseCommandOptions } from "../utils/command"
import type { Choice } from "../utils/chooser"
import { createLoggers } from "../utils/effect"
import { macchiato } from "../utils/theme"
import { workKindStyle, workStatusStyle } from "../workbase/work-target"
import {
	actionGroups,
	actActions,
	actionOutput,
	isActActionId,
	type ActAction,
	type ActEntity,
	type ActCheckoutState,
} from "./act-actions"
import {
	ActCancelled,
	actionPrompts,
	wizardInputs,
	actTabs,
	defaultInteraction,
	openActSession,
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
	readonly exitOnEscape?: boolean
}

const entityChoices = (
	nodes: readonly ActEntity[],
	twoRows = false,
): Choice<string>[] => {
	const name = (node: ActEntity) =>
		node.kind === "phase"
			? node.key.slice(node.key.lastIndexOf("/") + 1)
			: node.key
	const nameWidth = Math.min(
		32,
		Math.max(0, ...nodes.map((node) => name(node).length)),
	)
	const shorten = (text: string, width: number) =>
		text.length > width ? `${text.slice(0, width - 1)}…` : text
	return nodes
		.toSorted((a, b) => a.key.localeCompare(b.key))
		.map((node) => {
			const description = (
				"description" in node.data ? node.data.description : ""
			)
				?.replace(/\s+/g, " ")
				.trim()
			const parent =
				node.kind === "phase"
					? node.key.slice(0, node.key.lastIndexOf("/"))
					: undefined
			const blocked = node.readiness.blockers.some(
				(blocker) =>
					blocker.kind === "dependency" || blocker.kind === "validation",
			)
			const state = blocked
				? { icon: "󰀦", color: macchiato.yellow }
				: workStatusStyle[node.status]
			const segments = [
				{
					text: `${workKindStyle[node.kind].icon}  `,
					color: workKindStyle[node.kind].color,
				},
				{
					text: shorten(name(node), nameWidth).padEnd(nameWidth),
					color: macchiato.text,
				},
				{
					text: `  ${state.icon}  ${(blocked ? "blocked" : node.status).padEnd(9)}`,
					color: state.color,
				},
				...(parent
					? [{ text: `  in ${shorten(parent, 24)}`, color: macchiato.subtext0 }]
					: []),
				...(node.repositories.length
					? [
							{
								text: `    ${node.repositories.join(", ")}`,
								color: macchiato.overlay1,
							},
						]
					: []),
				...(description
					? [{ text: `  — ${description}`, color: macchiato.overlay0 }]
					: []),
			]
			return {
				key: node.id,
				value: node.id,
				segments,
				...(twoRows
					? {
							details: {
								title: [
									{
										text: `${workKindStyle[node.kind].icon}  `,
										color: workKindStyle[node.kind].color,
									},
									{ text: node.key, color: macchiato.text },
								],
								metadata: [
									{
										text: `  ${"repo" in node.data ? node.data.repo : (node.repositories[0] ?? "—")}  `,
										color: macchiato.overlay1,
									},
									{
										text: `${state.icon}  ${blocked ? "blocked" : node.status}`,
										color: state.color,
									},
								],
								description: description ?? "",
							},
						}
					: {}),
				label: segments.map((segment) => segment.text).join(""),
				plainLabel: `[${node.status}] ${node.kind} ${node.key}${blocked ? " blocked" : ""} ${node.repositories.join(" ")}${description ? ` — ${description}` : ""}`,
			}
		})
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
const entitySummary = (node: ActEntity) => ({
	kind: node.kind,
	id: node.id,
	key: node.key,
	status: node.status,
	description: "description" in node.data ? node.data.description : undefined,
	repo: "repo" in node.data ? node.data.repo : undefined,
	repositories: node.repositories,
	readiness: node.readiness,
	revision: node.data.sha256,
})

const actionChoices = (actions: readonly ActAction[]): Choice<string>[] =>
	actions.map(({ id, label, description, icon, color, blockedReason }) => {
		const availability = blockedReason ? ` — unavailable: ${blockedReason}` : ""
		return {
			key: id,
			value: id,
			label: `${icon}  ${label} — ${description}${availability}`,
			plainLabel: `${label} — ${description}${availability}`,
			segments: [
				{ text: `${icon}  `, color },
				{ text: label },
				{ text: ` — ${description}`, color: macchiato.overlay0 },
				...(blockedReason
					? [
							{
								text: availability,
								color: macchiato.yellow,
							},
						]
					: []),
			],
		}
	})

interface ActState {
	session?: Effect.Effect.Success<ReturnType<typeof openActSession>>
	recap: string[]
	root?: string
	view: "home" | "item-menu" | "goal-menu" | "flow"
	native: boolean
	notice: string
	item?: string
	goal?: string
}

export const act = (
	options: ActOptions = {},
	interaction: ActInteraction = defaultInteraction,
	work: StartWork = startWork,
) =>
	Effect.gen(function* () {
		const state: ActState = {
			recap: [],
			view: "home",
			native: false,
			notice: "",
		}
		let nextOptions = options
		const { log } = createLoggers(options)
		yield* Effect.gen(function* () {
			while (true) {
				state.view = "home"
				const keepGoing = yield* actStep(
					nextOptions,
					interaction,
					work,
					state,
				).pipe(
					Effect.tap(() =>
						Effect.sync(() => {
							state.goal = undefined
							state.item = undefined
						}),
					),
					Effect.as(true),
					Effect.catchAll((error) => {
						if (error instanceof ActCancelled) {
							if (state.view === "item-menu") state.item = undefined
							if (state.view === "goal-menu") state.goal = undefined
							return Effect.succeed(
								state.view !== "home" || options.exitOnEscape === false,
							)
						}
						if (!state.native || state.view === "home")
							return Effect.fail(error)
						state.goal = undefined
						state.notice = `󰅖  ${error instanceof Error ? error.message : String(error)}`
						return Effect.succeed(true)
					}),
				)
				if (
					(!state.native && options.exitOnEscape !== false) ||
					!keepGoing ||
					state.session?.quitRequested
				)
					break
				state.session?.resetCancellation()
				if (state.session?.takeNavigation()) {
					state.item = undefined
					state.goal = undefined
				}
				state.session?.notice(state.notice)
				nextOptions = {
					...options,
					cwd: state.root,
					directory: undefined,
					epicId: state.item?.startsWith("epic:")
						? state.item.slice(5)
						: undefined,
					taskId: state.item?.startsWith("phase:")
						? state.item.slice(6).split("/")[0]
						: state.item?.startsWith("task:")
							? state.item.slice(5)
							: undefined,
					phaseId: state.item?.startsWith("phase:")
						? state.item.slice(6).split("/")[1]
						: undefined,
					action: undefined,
				}
			}
		}).pipe(
			Effect.scoped,
			Effect.ensuring(
				Effect.sync(() => {
					if (state.recap.length)
						log(
							`\n  Agency\n\n${state.recap.map((line) => `  ${line}`).join("\n")}\n`,
						)
				}),
			),
		)
	})

const actStep = (
	options: ActOptions,
	interaction: ActInteraction,
	work: StartWork,
	state: ActState,
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
		const worktrees = yield* WorktreeService
		const { log } = createLoggers(options)
		const cwd = options.cwd ?? process.cwd()
		const path = resolve(cwd, options.directory ?? ".")
		const isDirectory = yield* fs.isDirectory(path)
		const isPath =
			isDirectory || Boolean(options.directory && (yield* fs.exists(path)))
		const { root, config } = yield* workbase.loadConfig(
			isDirectory ? path : isPath ? dirname(path) : cwd,
		)
		state.root = root
		const graph = yield* graphs.get({
			cwd: root,
			loadedConfig: { root, config },
			include: ["workspace"],
		})
		const checkoutStates = new Map<string, ActCheckoutState>()
		const materialized = graph.nodes.some(
			(node) => node.kind === "execution-unit" && node.workspace?.materialized,
		)
		for (const inspection of materialized
			? yield* worktrees.list(root, { materializedOnly: true })
			: []) {
			const id =
				inspection.owner.kind === "phase"
					? `phase:${inspection.owner.taskId}/${inspection.owner.phaseId}`
					: `task:${inspection.owner.taskId}`
			checkoutStates.set(id, {
				paths: inspection.checkouts.flatMap((checkout) =>
					checkout.exists
						? [checkout.path]
						: checkout.registeredPath
							? [checkout.registeredPath]
							: [],
				),
				conflicts: inspection.conflicts
					.filter((conflict) => conflict.kind !== "stale-registration")
					.map((conflict) => conflict.message),
				dirty: inspection.checkouts.some(
					(checkout) => checkout.exists && checkout.dirty !== false,
				),
			})
		}
		const nodes = graph.nodes.filter(
			(node): node is ActEntity =>
				node.kind === "epic" || node.kind === "task" || node.kind === "phase",
		)
		const recap = state.recap
		const session =
			state.session ??
			(!options.json &&
			interaction === defaultInteraction &&
			!config.chooserCommand &&
			process.stdin.isTTY &&
			process.stdout.isTTY
				? yield* Effect.acquireRelease(openActSession(), (session) =>
						session.close(),
					)
				: undefined)
		state.session = session
		state.native = Boolean(session)
		session?.notice(state.notice)
		const ui = session?.interaction ?? interaction
		const nativeOptions = {
			cwd: root,
			auto: options.auto,
			draft: options.draft,
			inputAllowed: options.inputAllowed,
			silent: session ? true : options.silent,
			verbose: options.verbose,
			checkoutStates,
		}
		const runWork: StartWork = session
			? (args) => work({ ...args, silent: options.silent })
			: work
		const globals = actActions(graph.nodes, nativeOptions, runWork)
		const catalog = new Map(
			nodes.map((node) => [
				node.id,
				actActions(graph.nodes, nativeOptions, runWork, node),
			]),
		)
		let selectedKey = options.epicId
			? `epic:${options.epicId}`
			: options.phaseId
				? `phase:${options.taskId}/${options.phaseId}`
				: options.taskId
					? `task:${options.taskId}`
					: options.directory
						? isPath
							? pathEntityKey(root, path)
							: `task:${options.directory}`
						: pathEntityKey(root, path)
		let actionId = options.action
		if (session && options.directory && isPath && !selectedKey && !actionId)
			session.activateTab("workbase")
		state.view = !selectedKey && !actionId ? "home" : "flow"
		if (actionId && !isActActionId(actionId))
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
		if (
			selectedKey &&
			!catalog.has(selectedKey) &&
			state.item === selectedKey
		) {
			state.item = undefined
			selectedKey = undefined
			state.view = "home"
		}
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
							.map(entitySummary),
						targets: globalAction
							? []
							: nodes
									.filter((node) => !selectedKey || node.id === selectedKey)
									.map((node) => {
										const actions = catalog.get(node.id)!.filter(matches)
										return {
											...entitySummary(node),
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
				const answer = yield* ui.select(prompt, choices, config.chooserCommand)
				if (answer === null) return yield* Effect.fail(new ActCancelled())
				return answer
			})
		if (!selectedKey && !actionId) {
			const goals = actionGroups.map(({ id, label, icon }) => ({
				key: id,
				label: `${icon}  ${label}`,
				plainLabel: label,
				value: id,
				segments: [
					{ text: `${icon}  `, color: macchiato.overlay1 },
					{ text: label },
				],
			}))
			let goal: string | undefined = state.goal
			if (goal) {
				state.view = "flow"
			} else if (ui.tabs) {
				type HomeChoice = { kind: "goal" | "item"; id: string }
				const chosen = yield* ui.tabs<HomeChoice>([
					{
						...actTabs[0],
						emptyLabel: "No tasks or phases yet",
						choices: entityChoices(
							nodes.filter(
								(node) => node.kind === "task" || node.kind === "phase",
							),
							true,
						).map((choice) => ({
							...choice,
							value: { kind: "item", id: choice.value },
						})),
					},
					{
						...actTabs[1],
						choices: goals
							.filter(
								(choice) =>
									!["browse", "split", "handoff"].includes(choice.value),
							)
							.map((choice) => ({
								...choice,
								value: { kind: "goal", id: choice.value },
							})),
					},
				])
				if (!chosen) return yield* Effect.fail(new ActCancelled())
				state.view = "flow"
				if (chosen.kind === "item") selectedKey = chosen.id
				else goal = chosen.id
			} else {
				goal = yield* select("Choose an action", goals)
				state.view = "flow"
			}
			if (goal === "browse") {
				if (!nodes.length)
					return yield* Effect.fail(
						new Error("No work items yet; choose Create a task first"),
					)
				selectedKey = yield* select("Choose an item", entityChoices(nodes))
			} else if (goal) {
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
				if (session && choices.length > 1) state.goal = goal
				state.view = "goal-menu"
				actionId =
					choices.length === 1
						? choices[0]!.id
						: yield* select(group.label, actionChoices(choices))
				state.view = "flow"
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
			selectedKey = yield* select("Choose an item", entityChoices(eligible))
		}
		const selected = nodes.find((node) => node.id === selectedKey)
		if (selected && session) {
			state.goal = undefined
			state.item = selected.id
			session.activateTab("workstream")
		}
		const actions = selected ? catalog.get(selected.id)! : globals
		if (!actionId) {
			state.view = "item-menu"
			const menuActions = actions.filter(
				(action) =>
					available(action) ||
					(action.id === "worktree-remove" &&
						action.blockedReason !== "Local checkout is not materialized"),
			)
			actionId = yield* select(
				`Act on ${selected!.kind} ${selected!.key}`,
				actionChoices(menuActions),
			)
			state.view = "flow"
		}
		const action = actions.find((action) => action.id === actionId)
		if (!action || action.blockedReason)
			return yield* Effect.fail(
				new Error(
					`Action '${actionId}' is unavailable: ${action?.blockedReason ?? "not found"}`,
				),
			)
		const prepare = (interaction: ActInteraction) =>
			action.prepare(
				actionPrompts(
					interaction,
					graph.nodes
						.filter((node) => node.kind === "repository")
						.map((node) => node.key),
					nodes.map((node) => node.key),
					config.chooserCommand,
				),
			)
		const plan = yield* session
			? wizardInputs(
					ui,
					prepare,
					() => !session.quitRequested && !session.navigationRequested,
					(message) => session.notice(message ? `󰀦  ${message}` : state.notice),
				)
			: prepare(ui)
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
				if (session) recap.push(`  Preview: ${shellCommand(command)}`)
				else log(shellCommand(command))
			state.notice = `  Preview: ${shellCommand(plan.command)}`
			return
		}
		session?.show(`󰔟  ${action.label}…`)
		// An interactive worker must receive a restored terminal.
		if (action.id === "work" && session) {
			yield* session.close()
			state.session = undefined
		}
		yield* (
			session && action.id !== "work"
				? Effect.raceFirst(plan.run, session.cancelled)
				: plan.run
		).pipe(
			Effect.tapError((error) =>
				Effect.sync(() => {
					if (session) {
						recap.push(
							`󰅖  ${action.label} ${error instanceof ActCancelled ? "interrupted; check item state before retrying" : "failed"}${selected ? ` — ${selected.key}` : ""}`,
						)
						state.notice = recap[recap.length - 1]!
					}
				}),
			),
		)
		if (session) {
			recap.push(`󰄬  ${action.label}${selected ? ` — ${selected.key}` : ""}`)
			state.notice = recap[recap.length - 1]!
			if (plan.next) {
				recap.push(
					`Item: ${plan.next.taskId}${plan.next.phaseId ? `/${plan.next.phaseId}` : ""}`,
				)
				state.notice += ` — ${plan.next.taskId}${plan.next.phaseId ? `/${plan.next.phaseId}` : ""}`
			}
			recap.push(`Command: ${shellCommand(plan.command)}`)
			if (action.id === "current-work") {
				const current = nodes.filter((node) => node.status === "working")
				state.notice = current.length
					? `  Working: ${current.map((node) => node.key).join(", ")}`
					: "  No work is in progress."
				recap.push(
					...(current.length
						? current.map(
								(node) =>
									`${node.kind} ${node.key} · ${node.repositories.join(", ")}${"description" in node.data && node.data.description ? ` — ${node.data.description}` : ""}`,
							)
						: ["No work is in progress."]),
				)
			}
		}
		if (plan.next) {
			const next = yield* select("Created. What next?", [
				{
					key: "finish",
					label: session
						? "Keep for later — return to tabs"
						: "Finish — keep this item for later",
					value: "finish",
				},
				{ key: "work", label: "Work on the new item now", value: "work" },
			])
			if (next === "work") {
				if (session) {
					yield* session.close()
					state.session = undefined
				}
				yield* work({ ...nativeOptions, silent: options.silent, ...plan.next })
				if (session) recap.push("󰄬  Work handoff completed")
			} else if (session) recap.push("Kept for later — work was not started.")
		}
	})

export const help = `
Usage: agency act [<directory-or-task-id> | --epic <id> | --task <id> [--phase <id>]] [--action <id>] [--dry-run | --json] [--auto] [--draft]

Choose a task/phase in Workstream, or press Tab for Workbase actions. Guided
creation offers an explicit Work choice afterward; creation alone never starts work.
Completed item actions return to a freshly loaded Workstream. Escape clears input,
then steps back through
wizard prompts, the action menu, and Workstream,
or exits from the front screen; Ctrl-C quits. A recap is printed when you exit.
An existing directory or file selects its containing epic, task, or phase.
A workbase path opens Workbase actions. Otherwise the positional value is a
task ID. Selectors skip item selection.

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
