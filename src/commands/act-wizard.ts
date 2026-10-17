import { Effect } from "effect"
import type { GraphNode } from "../graph-schema"
import { GraphService } from "../services/GraphService"
import { WorkbaseService } from "../services/WorkbaseService"
import {
	actActions,
	type ActCheckoutState,
	type ActEntity,
} from "./act-actions"
import { actionPrompts, wizardInputs, type ActInteraction } from "./act-prompts"
import { work as startWork } from "./work"

export const isEntity = (node: GraphNode): node is ActEntity =>
	node.kind === "epic" || node.kind === "task" || node.kind === "phase"

export const materializedCheckouts = (nodes: readonly GraphNode[]) => {
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
 * Collect an action's inputs with the act wizard, prefilled from `values`,
 * without running it. Returns the answered values by input ID, the same IDs
 * `agency act --json` templates use.
 */
export const collectActionInputs = (
	request: {
		readonly root: string
		readonly selector: { readonly task: string; readonly phase?: string } | null
		readonly actionId: string
		readonly values: Readonly<Record<string, string>>
	},
	interaction: ActInteraction,
	options: {
		readonly auto?: boolean
		readonly canGoBack?: () => boolean
		readonly onInputError?: (message?: string) => void
		/** The workbase and action resolved; called before any prompt. */
		readonly onLoaded?: (root: string, label: string) => void
	} = {},
) =>
	Effect.gen(function* () {
		const workbase = yield* WorkbaseService
		const graphs = yield* GraphService
		const { root, config } = yield* workbase.loadConfig(request.root)
		const { nodes } = yield* graphs.get({
			cwd: root,
			loadedConfig: { root, config },
			include: ["workspace"],
		})
		const { selector } = request
		const id = selector
			? selector.phase
				? `phase:${selector.task}/${selector.phase}`
				: `task:${selector.task}`
			: undefined
		const node = id
			? nodes.find(
					(candidate): candidate is ActEntity =>
						isEntity(candidate) && candidate.id === id,
				)
			: undefined
		if (id && !node)
			return yield* Effect.fail(new Error(`${id} no longer exists`))
		const action = actActions(
			nodes,
			{
				cwd: root,
				auto: options.auto,
				inputAllowed: true,
				silent: true,
				checkoutStates: materializedCheckouts(nodes),
			},
			startWork,
			node,
		).find((candidate) => candidate.id === request.actionId)
		if (!action)
			return yield* Effect.fail(
				new Error(
					`'${request.actionId}' is not offered${node ? ` for ${node.key}` : ""}`,
				),
			)
		if (action.blockedReason)
			return yield* Effect.fail(new Error(action.blockedReason))
		options.onLoaded?.(root, `${action.label}${node ? ` — ${node.key}` : ""}`)
		const inputs = action.inputs ?? []
		if (!inputs.length) return {}
		const values: Record<string, string> = {}
		const answered: (string | null)[] = []
		yield* wizardInputs(
			interaction,
			(ui) => {
				for (const key of Object.keys(values)) delete values[key]
				answered.length = 0
				return action.prepare(
					actionPrompts(
						ui,
						nodes
							.filter((candidate) => candidate.kind === "repository")
							.map((candidate) => candidate.key),
						nodes.filter(isEntity).map((candidate) => candidate.key),
						config.chooserCommand,
						{ inputs, defaults: request.values, values, answered },
					),
				)
			},
			options.canGoBack ?? (() => true),
			options.onInputError,
		)
		// Prompts answer inputs by position; never let a drift misplace a value.
		if (!answersInputs(answered, inputs))
			return yield* Effect.fail(
				new Error(
					`The act wizard's prompts for '${action.id}' no longer match its inputs`,
				),
			)
		return { ...values }
	})

/** Every declared input was answered exactly once, and nothing else was. */
const answersInputs = (
	answered: readonly (string | null)[],
	inputs: readonly { readonly id: string }[],
) =>
	answered.length === inputs.length &&
	inputs.every((input) => answered.filter((id) => id === input.id).length === 1)
