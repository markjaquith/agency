import { Schema } from "effect"
import { isAbsolute, join, relative, sep } from "node:path"
import { RuntimeKind, type RuntimePane, type RuntimeSnapshot } from "./runtime"

export const RUNTIME_BINDING_VERSION = 1 as const

export const RuntimeBinding = Schema.Struct({
	version: Schema.Literal(RUNTIME_BINDING_VERSION),
	workbase: Schema.String,
	unit: Schema.String,
	runtime: RuntimeKind,
	paneId: Schema.String,
	tabId: Schema.NullOr(Schema.String),
	workspaceId: Schema.NullOr(Schema.String),
	agent: Schema.NullOr(Schema.String),
	agentSessionId: Schema.NullOr(Schema.String),
	agencySessionId: Schema.NullOr(Schema.String),
	boundAt: Schema.String,
})
export type RuntimeBinding = Schema.Schema.Type<typeof RuntimeBinding>

/**
 * - live: the bound agent is visible in its recorded pane (or, with no known
 *   session, an agent in that pane still works inside the unit).
 * - moved: the bound agent session is visible in exactly one different pane.
 * - duplicated: the bound agent session is visible in more than one pane.
 * - gone: neither the agent session nor a matching agent in the recorded pane
 *   remain, or a newer binding claimed that pane.
 */
type RuntimeBindingState = "live" | "moved" | "duplicated" | "gone"

export interface ReconciledBinding {
	readonly binding: RuntimeBinding
	readonly state: RuntimeBindingState
	/** Panes currently hosting the binding; for gone, the agent-less recorded pane if it remains. */
	readonly panes: readonly RuntimePane[]
}

export interface InferredBinding {
	readonly unit: string
	readonly matchedBy: "checkout" | "directory"
	/** Which pane directory matched: the foreground process's, or the pane's. */
	readonly matchedPath: "foregroundCwd" | "cwd"
	readonly pane: RuntimePane
}

export interface RuntimeUnit {
	readonly id: string
	/** Item directory candidates (for example, as recorded and as resolved). */
	readonly directories: readonly string[]
	readonly checkoutPaths: readonly string[]
}

export interface RuntimeReconciliation {
	readonly bindings: readonly ReconciledBinding[]
	readonly inferred: readonly InferredBinding[]
	readonly unmanaged: readonly RuntimePane[]
}

export const executionUnitPaths = (
	root: string,
	unit: { readonly taskId: string; readonly phaseId?: string },
	repo: string,
) => {
	const directory = unit.phaseId
		? join(root, "tasks", unit.taskId, "phases", unit.phaseId)
		: join(root, "tasks", unit.taskId)
	return { directory, checkoutPath: join(directory, "code", repo) }
}

const contains = (parent: string, path: string) => {
	const relation = relative(parent, path)
	return (
		relation === "" ||
		(!isAbsolute(relation) &&
			relation !== ".." &&
			!relation.startsWith(`..${sep}`))
	)
}

const insideUnit = (pane: RuntimePane, unit: RuntimeUnit | undefined) =>
	unit !== undefined &&
	[pane.foregroundCwd, pane.cwd].some(
		(path) =>
			path !== null &&
			[...unit.directories, ...unit.checkoutPaths].some((candidate) =>
				contains(candidate, path),
			),
	)

interface ReconciledCandidate extends ReconciledBinding {
	/** True when the state rests on the recorded pane rather than a session match. */
	readonly paneFallback: boolean
}

const reconcileBinding = (
	binding: RuntimeBinding,
	snapshot: RuntimeSnapshot,
	unit: RuntimeUnit | undefined,
): ReconciledCandidate => {
	const panes = snapshot.panes
	const sessionPanes = binding.agentSessionId
		? panes.filter((pane) => pane.agentSessionId === binding.agentSessionId)
		: []
	if (sessionPanes.length > 1) {
		return {
			binding,
			state: "duplicated",
			panes: sessionPanes,
			paneFallback: false,
		}
	}
	if (sessionPanes.length === 1) {
		return {
			binding,
			state: sessionPanes[0]!.paneId === binding.paneId ? "live" : "moved",
			panes: sessionPanes,
			paneFallback: false,
		}
	}
	const bound = panes.find((pane) => pane.paneId === binding.paneId)
	if (!bound) return { binding, state: "gone", panes: [], paneFallback: false }
	// The recorded pane still hosts an agent whose session identity is unknown
	// on one side. Pane IDs are reused (and restart after a Herdr restart), so
	// only treat it as the bound agent while it still works inside the unit.
	if (
		bound.agent !== null &&
		(binding.agentSessionId === null || bound.agentSessionId === null) &&
		insideUnit(bound, unit)
	) {
		const shared = bound.agentSessionId
			? panes.filter((pane) => pane.agentSessionId === bound.agentSessionId)
			: [bound]
		return {
			binding,
			state: shared.length > 1 ? "duplicated" : "live",
			panes: shared,
			paneFallback: true,
		}
	}
	return { binding, state: "gone", panes: [bound], paneFallback: false }
}

/**
 * When several bindings resolve to the same pane only through the recorded-pane
 * fallback, the most recent launch owns it and the older bindings are gone.
 */
const resolveSharedPanes = (
	candidates: readonly ReconciledCandidate[],
): ReconciledBinding[] => {
	const owners = new Map<string, RuntimeBinding>()
	for (const candidate of candidates) {
		if (!candidate.paneFallback) continue
		const owner = owners.get(candidate.binding.paneId)
		if (!owner || candidate.binding.boundAt > owner.boundAt) {
			owners.set(candidate.binding.paneId, candidate.binding)
		}
	}
	return candidates.map(({ paneFallback, ...item }) =>
		paneFallback && owners.get(item.binding.paneId) !== item.binding
			? {
					binding: item.binding,
					state: "gone",
					panes: item.panes.filter(
						(pane) => pane.paneId === item.binding.paneId,
					),
				}
			: item,
	)
}

interface UnitMatch {
	readonly unit: string
	readonly matchedBy: "checkout" | "directory"
	readonly matchedPath: "foregroundCwd" | "cwd"
	readonly depth: number
}

const inferUnit = (
	pane: RuntimePane,
	units: readonly RuntimeUnit[],
): UnitMatch | null => {
	let best = null as UnitMatch | null
	for (const [matchedPath, path] of [
		["foregroundCwd", pane.foregroundCwd],
		["cwd", pane.cwd],
	] as const) {
		if (!path) continue
		for (const unit of units) {
			for (const [matchedBy, candidates] of [
				["checkout", unit.checkoutPaths],
				["directory", unit.directories],
			] as const) {
				for (const candidate of candidates) {
					if (!contains(candidate, path)) continue
					const depth = candidate.length
					if (!best || depth > best.depth) {
						best = { unit: unit.id, matchedBy, matchedPath, depth }
					}
				}
			}
		}
		if (best) return best
	}
	return best
}

/**
 * Classify recorded bindings against a live snapshot, then map remaining agent
 * panes to execution units by working directory as lower-confidence inferences.
 */
export const reconcileRuntime = (
	bindings: readonly RuntimeBinding[],
	snapshot: RuntimeSnapshot,
	units: readonly RuntimeUnit[],
): RuntimeReconciliation => {
	const unitsById = new Map(units.map((unit) => [unit.id, unit]))
	const reconciled = resolveSharedPanes(
		bindings.map((binding) =>
			reconcileBinding(binding, snapshot, unitsById.get(binding.unit)),
		),
	)
	const claimed = new Set(
		reconciled
			.filter((item) => item.state !== "gone")
			.flatMap((item) => item.panes.map((pane) => pane.paneId)),
	)
	const inferred: InferredBinding[] = []
	const unmanaged: RuntimePane[] = []
	for (const pane of snapshot.panes) {
		if (pane.agent === null || claimed.has(pane.paneId)) continue
		const match = inferUnit(pane, units)
		if (match) {
			inferred.push({
				unit: match.unit,
				matchedBy: match.matchedBy,
				matchedPath: match.matchedPath,
				pane,
			})
		} else {
			unmanaged.push(pane)
		}
	}
	return { bindings: reconciled, inferred, unmanaged }
}
