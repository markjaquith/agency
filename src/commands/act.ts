import { Schema, Effect } from "effect"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { ActDiscovery } from "../act-schema"
import type { GraphNode } from "../graph-schema"
import { FileSystemService } from "../services/FileSystemService"
import { GraphService } from "../services/GraphService"
import { WorkbaseService } from "../services/WorkbaseService"
import { WorktreeService } from "../services/WorktreeService"
import { shellCommand, type BaseCommandOptions } from "../utils/command"
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
	recordingInteraction,
	replayInteraction,
	type ActInteraction,
} from "./act-prompts"
import {
	applyOptimistic,
	makeActionQueue,
	queuedActionStatus,
	type ActionQueue,
	type QueueJob,
} from "./act-queue"
import { work as startWork, type StartWork } from "./work"
import { hasPendingRebase } from "../services/RebaseService"

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
/** Actions whose availability depends on checkout dirtiness or conflicts. */
const CHECKOUT_STATE_ACTIONS = new Set(["worktree-remove", "rebase"])
/** The item a selector, task ID, or item path names, if any. */
const requestedKey = (
	options: ActOptions,
	root: string,
	path: string,
	isPath: boolean,
) =>
	options.epicId
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
const creationDefaults = (config: {
	readonly branchNameCommand?: readonly string[]
}) => ({
	branch: config.branchNameCommand
		? {
				configured: true as const,
				guidance:
					"Omit --branch to use the workbase branchNameCommand; pass it only for an explicit override.",
			}
		: {
				configured: false as const,
				task: "task/<id>",
				phase: "task/<task-id>-<phase-id>",
			},
})
const available = (action: ActAction) => !action.blockedReason
const checkoutState = (inspection: {
	readonly checkouts: readonly {
		readonly exists: boolean
		readonly path: string
		readonly registeredPath: string | null
		readonly dirty: boolean | null
	}[]
	readonly conflicts: readonly {
		readonly kind: string
		readonly message: string
	}[]
}): ActCheckoutState => ({
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

interface RecordedAction {
	readonly itemId: string
	readonly actionId: string
	readonly answers: readonly string[]
}

interface QueuedAction extends RecordedAction {
	readonly root: string
}

type NativeOptions = Parameters<typeof actActions>[1]

const isEntity = (node: GraphNode): node is ActEntity =>
	node.kind === "epic" || node.kind === "task" || node.kind === "phase"

const materializedCheckouts = (nodes: readonly GraphNode[]) => {
	const states = new Map<string, ActCheckoutState>()
	for (const node of nodes) {
		if (node.kind !== "execution-unit" || !node.workspace?.materialized)
			continue
		const id =
			"phaseId" in node.data
				? `phase:${node.data.taskId}/${node.data.phaseId}`
				: `task:${node.data.taskId}`
		states.set(id, {
			paths: [node.workspace.checkoutPath],
			conflicts: [],
			dirty: false,
		})
	}
	return states
}

/**
 * Rebuild a chosen item action from current state and replay its recorded
 * inputs, so revision guards and availability checks reflect that state.
 */
const recordedPlan = (
	nodes: readonly GraphNode[],
	options: NativeOptions,
	work: StartWork,
	recorded: RecordedAction,
	revision: string,
	chooser?: readonly string[],
) =>
	Effect.gen(function* () {
		const current = nodes.find(
			(node): node is ActEntity =>
				isEntity(node) && node.id === recorded.itemId,
		)
		if (!current)
			return yield* Effect.fail(
				new Error(`Work item '${recorded.itemId}' no longer exists`),
			)
		if (current.data.sha256 !== revision)
			return yield* Effect.fail(
				new Error(`${current.kind} ${current.key} changed since it was chosen`),
			)
		const action = actActions(nodes, options, work, current).find(
			(candidate) => candidate.id === recorded.actionId,
		)
		if (!action || action.blockedReason)
			return yield* Effect.fail(
				new Error(
					`Action '${recorded.actionId}' is unavailable: ${action?.blockedReason ?? "not found"}`,
				),
			)
		return yield* action.prepare(
			actionPrompts(
				replayInteraction(recorded.answers),
				nodes
					.filter((node) => node.kind === "repository")
					.map((node) => node.key),
				nodes.filter(isEntity).map((node) => node.key),
				chooser,
			),
		)
	})

const goalChoices = actionGroups.map(({ id, label, icon }) => ({
	key: id,
	label: `${icon}  ${label}`,
	plainLabel: label,
	value: id,
	segments: [{ text: `${icon}  `, color: macchiato.overlay1 }, { text: label }],
}))

type HomeChoice = { kind: "goal" | "item"; id: string }

const homeTabs = (nodes: readonly ActEntity[]) => [
	{
		...actTabs[0],
		emptyLabel: "No tasks or phases yet",
		choices: entityChoices(
			nodes.filter((node) => node.kind === "task" || node.kind === "phase"),
			true,
		).map((choice) => ({
			...choice,
			value: { kind: "item", id: choice.value } as HomeChoice,
		})),
	},
	{
		...actTabs[1],
		choices: goalChoices
			.filter(
				(choice) => !["browse", "split", "handoff"].includes(choice.value),
			)
			.map((choice) => ({
				...choice,
				value: { kind: "goal", id: choice.value } as HomeChoice,
			})),
	},
]

const queueEntry = (job: QueueJob<QueuedAction>) =>
	job.state === "running"
		? { icon: "󰔟", text: job.label, color: macchiato.blue }
		: job.state === "pending"
			? { icon: "󰥔", text: `${job.label} · queued`, color: macchiato.overlay1 }
			: job.state === "failed"
				? {
						icon: "󰅖",
						text: `${job.label} — ${job.error}`,
						color: macchiato.red,
					}
				: {
						icon: "󰜺",
						text: `${job.label} — ${job.error}`,
						color: macchiato.yellow,
					}

const settledMessage = (job: QueueJob<QueuedAction>) =>
	job.state === "done"
		? `󰄬  ${job.label}`
		: job.state === "failed"
			? `󰅖  ${job.label} failed — ${job.error}`
			: `󰜺  ${job.label} skipped — ${job.error}`

/** Render queue changes: footer, optimistic rows, notices, and the recap. */
const queueChanged = (state: ActState) => {
	const queue = state.queue
	if (!queue) return
	const settled = queue.jobs
		.filter((job) => job.settled !== undefined && job.settled > state.reported)
		.toSorted((a, b) => a.settled! - b.settled!)
	state.reported = queue.sequence
	for (const job of settled) {
		state.recap.push(settledMessage(job))
		state.notice = settledMessage(job)
	}
	state.session?.queue(queue.visible.map(queueEntry))
	if (settled.length) state.session?.announce(state.notice)
	state.refreshHome?.()
}

interface ActState {
	session?: Effect.Success<ReturnType<typeof openActSession>>
	queue?: ActionQueue<QueuedAction>
	/** Last queue sequence reported to the notice and recap. */
	reported: number
	/** The last loaded graph and the queue sequence when it was loaded. */
	loaded?: {
		readonly root: string
		readonly nodes: readonly GraphNode[]
		readonly snapshot: number
	}
	/** Re-render the open Workstream with the current optimistic state. */
	refreshHome?: () => void
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
			reported: 0,
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
					Effect.catch((error) => {
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
			// Queued mutations finish before the session and its worker are released.
			Effect.ensuring(
				Effect.suspend(() => {
					const queue = state.queue
					if (!queue?.busy) return Effect.void
					state.session?.show(`󰔟  Finishing ${queue.active} queued action(s)…`)
					return queue.drain
				}),
			),
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
		state.refreshHome = undefined
		// While mutations are queued, keep the loaded graph: the optimistic overlay
		// supplies their changes and reads never race the background writes.
		const cached =
			state.queue?.busy && state.loaded?.root === root
				? state.loaded
				: undefined
		const snapshot = cached?.snapshot ?? state.queue?.sequence ?? 0
		const graph = {
			nodes:
				cached?.nodes ??
				(yield* graphs.get({
					cwd: root,
					loadedConfig: { root, config },
					include: ["workspace"],
				})).nodes,
		}
		state.loaded = { root, nodes: graph.nodes, snapshot }
		const checkoutStates = materializedCheckouts(graph.nodes)
		// Inspecting a checkout runs a full `git status`, which is slow in large
		// repositories, so JSON discovery inspects only checkouts whose reported
		// actions depend on more than materialization.
		if (
			options.json &&
			checkoutStates.size > 0 &&
			(!options.action || CHECKOUT_STATE_ACTIONS.has(options.action))
		) {
			const selected = requestedKey(options, root, path, isPath)
			if (selected === undefined) {
				checkoutStates.clear()
				for (const inspection of yield* worktrees.list(root, {
					materializedOnly: true,
				})) {
					const id =
						inspection.owner.kind === "phase"
							? `phase:${inspection.owner.taskId}/${inspection.owner.phaseId}`
							: `task:${inspection.owner.taskId}`
					checkoutStates.set(id, checkoutState(inspection))
				}
			} else if (checkoutStates.has(selected)) {
				const [taskId, phaseId] = selected
					.slice(selected.indexOf(":") + 1)
					.split("/")
				checkoutStates.set(
					selected,
					checkoutState(yield* worktrees.inspect(taskId!, phaseId, root)),
				)
			}
		}
		const pendingRebases = new Set<string>()
		yield* Effect.forEach(
			graph.nodes,
			(node) =>
				node.kind !== "execution-unit" || !node.workspace?.materialized
					? Effect.void
					: hasPendingRebase(node.workspace.checkoutPath).pipe(
							Effect.map((pending) => {
								if (pending)
									pendingRebases.add(
										"phaseId" in node.data
											? `phase:${node.data.taskId}/${node.data.phaseId}`
											: `task:${node.data.taskId}`,
									)
							}),
						),
			{ concurrency: 8, discard: true },
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
			pendingRebases,
		}
		const runWork: StartWork = session
			? (args) => work({ ...args, silent: options.silent })
			: work
		if (session && !state.queue) {
			const queue = makeActionQueue<QueuedAction>(() => queueChanged(state))
			state.queue = queue
			yield* Effect.forkScoped(
				queue.worker((job, revision) =>
					Effect.gen(function* () {
						const current = yield* graphs.get({ cwd: job.root })
						const plan = yield* recordedPlan(
							current.nodes,
							{ ...nativeOptions, cwd: job.root, checkoutStates: new Map() },
							runWork,
							job,
							revision,
						)
						yield* plan.run
						const after = yield* graphs.get({ cwd: job.root })
						return (
							after.nodes
								.filter(isEntity)
								.find((node) => node.id === job.itemId)?.data.sha256 ?? null
						)
					}),
				),
			)
		}
		// Display and availability include queued changes until they settle.
		let seen = snapshot
		let viewNodes: readonly GraphNode[] = graph.nodes
		let nodes: readonly ActEntity[] = []
		let globals: readonly ActAction[] = []
		let catalog = new Map<string, readonly ActAction[]>()
		const load = () => {
			seen = state.queue?.sequence ?? 0
			viewNodes = applyOptimistic(
				graph.nodes,
				state.queue?.overlay(snapshot) ?? [],
			)
			nodes = viewNodes.filter(isEntity)
			globals = actActions(viewNodes, nativeOptions, runWork)
			catalog = new Map(
				nodes.map((node) => [
					node.id,
					actActions(viewNodes, nativeOptions, runWork, node),
				]),
			)
		}
		load()
		let selectedKey = requestedKey(options, root, path, isPath)
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
					yield* Schema.decodeUnknownEffect(ActDiscovery)({
						creationDefaults: creationDefaults(config),
						workbase: {
							root,
							autoArchive: config.autoArchive ?? false,
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
			let goal: string | undefined = state.goal
			if (goal) {
				state.view = "flow"
			} else if (ui.tabs) {
				if (session)
					state.refreshHome = () => {
						load()
						session.refreshTabs(homeTabs(nodes))
					}
				const chosen = yield* ui.tabs<HomeChoice>(homeTabs(nodes)).pipe(
					Effect.ensuring(
						Effect.sync(() => {
							state.refreshHome = undefined
						}),
					),
				)
				if (!chosen) return yield* Effect.fail(new ActCancelled())
				state.view = "flow"
				if (chosen.kind === "item") selectedKey = chosen.id
				else goal = chosen.id
			} else {
				goal = yield* select("Choose an action", goalChoices)
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
		let actions = selected ? catalog.get(selected.id)! : globals
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
		if (
			selected &&
			selected.kind !== "epic" &&
			actionId === "worktree-remove" &&
			!options.json
		) {
			const inspection = yield* worktrees.inspect(
				selected.kind === "phase"
					? selected.key.slice(0, selected.key.lastIndexOf("/"))
					: selected.key,
				selected.kind === "phase"
					? selected.key.slice(selected.key.lastIndexOf("/") + 1)
					: undefined,
				root,
			)
			checkoutStates.set(selected.id, checkoutState(inspection))
			actions = actActions(viewNodes, nativeOptions, runWork, selected)
		}
		const action = actions.find((action) => action.id === actionId)
		if (!action || action.blockedReason)
			return yield* Effect.fail(
				new Error(
					`Action '${actionId}' is unavailable: ${action?.blockedReason ?? "not found"}`,
				),
			)
		const answers: string[] = []
		const prepare = (interaction: ActInteraction) => {
			answers.length = 0
			return action.prepare(
				actionPrompts(
					recordingInteraction(interaction, answers),
					graph.nodes
						.filter((node) => node.kind === "repository")
						.map((node) => node.key),
					nodes.map((node) => node.key),
					config.chooserCommand,
				),
			)
		}
		let plan = yield* session
			? wizardInputs(
					ui,
					prepare,
					() => !session.quitRequested && !session.navigationRequested,
					(message) => session.notice(message ? `󰀦  ${message}` : state.notice),
				)
			: prepare(ui)
		const queue = session ? state.queue : undefined
		const optimisticStatus = queuedActionStatus[action.id]
		if (queue && selected && optimisticStatus && !options.dryRun) {
			const label = `${action.label} — ${selected.key}`
			const queued = queue.enqueue({
				itemId: selected.id,
				label,
				status: optimisticStatus,
				payload: { itemId: selected.id, actionId: action.id, answers, root },
				revision: selected.data.sha256,
				snapshot,
				seen,
			})
			if ("error" in queued) return yield* Effect.fail(new Error(queued.error))
			state.notice = `󰥔  Queued ${label}`
			return
		}
		// Other actions run in the foreground after queued mutations settle.
		if (queue?.busy) {
			session!.show(`󰔟  Waiting for ${queue.active} queued action(s)…`)
			yield* Effect.raceFirst(queue.drain, session!.cancelled)
		}
		if (selected) {
			const basis = queue
				? queue.basis(selected.id, selected.data.sha256, snapshot, seen)
				: { revision: selected.data.sha256 }
			if ("error" in basis) return yield* Effect.fail(new Error(basis.error))
			const fresh = yield* graphs.get({ cwd: root })
			const current = fresh.nodes.find(
				(node): node is ActEntity =>
					node.id === selected.id &&
					(node.kind === "task" ||
						node.kind === "phase" ||
						node.kind === "epic"),
			)
			if (
				!("revision" in basis) ||
				!current ||
				current.data.sha256 !== basis.revision ||
				!actActions(fresh.nodes, nativeOptions, work, current).some(
					(candidate) => candidate.id === actionId && available(candidate),
				)
			)
				return yield* Effect.fail(
					new Error("Selected work item changed; run agency act again"),
				)
			// Queued changes completed since loading: guard against their result.
			if (basis.revision !== selected.data.sha256)
				plan = yield* recordedPlan(
					fresh.nodes,
					nativeOptions,
					runWork,
					{ itemId: selected.id, actionId: action.id, answers },
					basis.revision,
					config.chooserCommand,
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
			const warnings = plan.warnings ?? []
			if (warnings.length) {
				recap.push(...warnings.map((warning) => `󰀦  ${warning}`))
				state.notice = `󰀦  ${action.label} done — ${warnings[0]}${warnings.length > 1 ? ` (+${warnings.length - 1} more in the exit recap)` : ""}`
			}
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
In the built-in TUI, status changes queue in the background and are shown
immediately; failures roll back. Exiting waits for queued changes.
An existing directory or file selects its containing epic, task, or phase.
A workbase path opens Workbase actions. Otherwise the positional value is a
task ID. Selectors skip item selection.
JSON discovery includes creation defaults identifying when callers should omit
--branch so the workbase branchNameCommand can choose it.
JSON discovery also includes the effective auto-archive setting and its commands.

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
