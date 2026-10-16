import { Result, Schema } from "effect"
import { createHash } from "node:crypto"
import type {
	ActionPrecondition,
	AttentionSignal,
	AttentionSubject,
	AttentionWorkbaseRef,
	SupervisorAction,
} from "../attention-schema"
import {
	TRIAGE_VERSION,
	TriageResponse,
	type TriageAssessment,
} from "../triage-schema"
import {
	effectivePullRequestState,
	runtimeRef,
	subjectFor,
	unitPanes,
	unitScope,
	type AttentionSnapshot,
	type AttentionUnit,
	type AttentionWorkbase,
	type CatalogAction,
} from "./attention"
import type { RuntimeAgentStatus, RuntimePane } from "./runtime"

const WAITING = new Set<RuntimeAgentStatus>(["idle", "done", "blocked"])
export const TRANSCRIPT_LINES = 120
const TRANSCRIPT_CHARS = 6000
/** Model-written action IDs start with this prefix. */
const MODEL_ACTION_PREFIX = "triage:"

/** One supervised item: an execution unit, or a pane outside any unit. */
export interface TriageItem {
	readonly key: string
	readonly workbase: AttentionWorkbase | null
	readonly unit: AttentionUnit | null
	readonly panes: readonly (RuntimePane & {
		readonly binding: "recorded" | "inferred" | null
	})[]
	readonly signals: readonly AttentionSignal[]
	readonly subject: AttentionSubject
	/** Available `agency act` actions: the unit's, or the workbase's for a pane. */
	readonly agencyActions: readonly CatalogAction[]
}

export interface TranscriptTail {
	readonly paneId: string
	readonly text: string
}

/** Supervisor feedback about one item, as sent to the triage agent. */
export interface ItemFeedback {
	readonly recentActions: readonly unknown[]
	readonly snoozes: readonly unknown[]
	readonly dismissals: readonly unknown[]
}

const sha256 = (value: string) =>
	createHash("sha256").update(value).digest("hex")

/** JSON with sorted object keys, so equal values serialize identically. */
const canonical = (value: unknown): string =>
	JSON.stringify(value, (_, inner: unknown) =>
		inner && typeof inner === "object" && !Array.isArray(inner)
			? Object.fromEntries(
					Object.entries(inner).sort(([a], [b]) => a.localeCompare(b)),
				)
			: inner,
	)

const available = (actions: readonly CatalogAction[]) =>
	actions.filter((action) => action.available)

/**
 * Items worth triaging: units with signals, live panes, or an active claim,
 * plus panes that signals report outside any unit.
 */
export const triageItems = (
	snapshot: AttentionSnapshot,
	signals: readonly AttentionSignal[],
): TriageItem[] => {
	const items: TriageItem[] = []
	const runtime = snapshot.runtime.provider
	for (const workbase of snapshot.workbases) {
		const roots = new Set(workbase.roots)
		for (const unit of workbase.units) {
			const unitSignals = signals.filter(
				(signal) =>
					signal.subject.item?.unit === unit.item.unit &&
					signal.subject.workbase !== null &&
					roots.has(signal.subject.workbase.root),
			)
			const panes = unitPanes(unit)
			const claimed =
				!unit.item.archived &&
				(unit.status === "working" || unit.status === "delegated")
			if (unitSignals.length === 0 && panes.length === 0 && !claimed) continue
			items.push({
				key: unitScope(workbase, unit),
				workbase,
				unit,
				panes: panes.map((entry) => ({
					...entry.pane,
					binding: entry.binding,
				})),
				signals: unitSignals,
				subject: subjectFor(
					workbase,
					unit,
					runtime ? panes.map((entry) => runtimeRef(runtime, entry.pane)) : [],
				),
				agencyActions: available(unit.actions),
			})
		}
	}
	const paneItems = new Map<string, TriageItem>()
	const panesOf = (signal: AttentionSignal) =>
		snapshot.runtime.panes
			.filter((pane) =>
				signal.subject.runtime.some((item) => item.paneId === pane.paneId),
			)
			.map((pane) => ({ ...pane, binding: null }))
	for (const signal of signals) {
		if (signal.subject.item) continue
		const ref = signal.subject.runtime[0]
		if (!ref) continue
		const key = `${ref.runtime}:${ref.paneId}`
		const existing = paneItems.get(key)
		if (existing) {
			const known = new Set(existing.panes.map((pane) => pane.paneId))
			paneItems.set(key, {
				...existing,
				panes: [
					...existing.panes,
					...panesOf(signal).filter((pane) => !known.has(pane.paneId)),
				],
				signals: [...existing.signals, signal],
			})
			continue
		}
		const root = signal.subject.workbase?.root
		const workbase =
			(root &&
				snapshot.workbases.find((candidate) =>
					candidate.roots.includes(root),
				)) ||
			null
		paneItems.set(key, {
			key,
			workbase,
			unit: null,
			panes: panesOf(signal),
			signals: [signal],
			subject: signal.subject,
			agencyActions: workbase ? available(workbase.actions) : [],
		})
	}
	return [...items, ...paneItems.values()]
}

/** Split items into batches of at most `size`, preserving order. */
export const chunk = <A>(items: readonly A[], size: number): A[][] => {
	const chunks: A[][] = []
	for (let index = 0; index < items.length; index += size)
		chunks.push(items.slice(index, index + size))
	return chunks
}

/** Panes whose agents wait for input, whose transcript tails triage reads. */
export const waitingPanes = (item: TriageItem) =>
	item.panes.filter((pane) => WAITING.has(pane.agentStatus))

/** Bound a transcript to its last lines and characters. */
export const boundTranscript = (text: string) => {
	const lines = text.replace(/\s+$/, "").split("\n")
	const tail = lines.slice(-TRANSCRIPT_LINES).join("\n")
	return tail.length > TRANSCRIPT_CHARS ? tail.slice(-TRANSCRIPT_CHARS) : tail
}

const paneFacts = (pane: TriageItem["panes"][number]) => ({
	paneId: pane.paneId,
	tabId: pane.tabId,
	workspaceId: pane.workspaceId,
	agent: pane.agent,
	agentSessionId: pane.agentSessionId,
	agentStatus: pane.agentStatus,
	cwd: pane.cwd,
	foregroundCwd: pane.foregroundCwd,
	binding: pane.binding,
})

const unitFacts = (unit: AttentionUnit) => ({
	unit: unit.item.unit,
	kind: unit.item.kind,
	taskId: unit.item.taskId,
	phaseId: unit.item.phaseId ?? null,
	path: unit.item.path,
	archived: unit.item.archived,
	status: unit.status,
	review: unit.review,
	revision: unit.revision,
	parentPath: unit.parent?.path ?? null,
})

const pullRequestFacts = (unit: AttentionUnit | null) =>
	unit?.pr
		? {
				url: unit.pr.url,
				state: effectivePullRequestState(unit.pr),
				recordedState: unit.pr.recordedState,
				live: unit.pr.live,
			}
		: null

/** Ticket state without transient failure reasons. */
const ticketFacts = (unit: AttentionUnit | null) => {
	const ticket = unit?.ticket
	if (!ticket) return null
	if (ticket.state === "unavailable" || ticket.state === "unsupported") {
		const { reason: _reason, ...rest } = ticket
		return rest
	}
	return ticket
}

const signalFacts = (signal: AttentionSignal) => ({
	id: signal.id,
	kind: signal.kind,
	title: signal.title,
	evidence: signal.evidence,
	actions: signal.actions,
})

/**
 * A digest of everything triage judges an item on: its state, its transcript
 * tails, the supervisor's actions on it, and the run context (contract, agent
 * profile, prompts, and model). An unchanged fingerprint means a cached
 * assessment still applies.
 */
export const itemFingerprint = (
	item: TriageItem,
	transcripts: readonly TranscriptTail[],
	actions: readonly unknown[],
	contextDigest: string,
) =>
	sha256(
		canonical({
			contract: TRIAGE_VERSION,
			context: contextDigest,
			key: item.key,
			unit: item.unit ? unitFacts(item.unit) : null,
			pullRequest: pullRequestFacts(item.unit),
			ticket: ticketFacts(item.unit),
			panes: item.panes.map(paneFacts),
			signals: item.signals.map(signalFacts),
			agencyActions: item.agencyActions,
			transcripts: transcripts.map((tail) => ({
				paneId: tail.paneId,
				sha256: sha256(tail.text),
			})),
			actions,
		}),
	)

/** The structured snapshot entry the triage agent sees for one item. */
export const itemSnapshot = (
	item: TriageItem,
	transcripts: readonly TranscriptTail[],
	previous: TriageAssessment | null,
	feedback: ItemFeedback,
) => ({
	key: item.key,
	subject: item.subject,
	item: item.unit ? unitFacts(item.unit) : null,
	pullRequest: pullRequestFacts(item.unit),
	ticket: item.unit?.ticket ?? null,
	panes: item.panes.map((pane) => ({
		...paneFacts(pane),
		terminalTitle: pane.terminalTitle,
	})),
	signals: item.signals.map(signalFacts),
	availableAgencyActions: item.agencyActions.map(
		({ id, label, command, commandTemplate, inputs }) => ({
			id,
			label,
			command,
			commandTemplate,
			inputs,
		}),
	),
	agencyCwd: item.workbase?.ref.root ?? null,
	transcriptTails: transcripts,
	previousAssessment: previous,
	...feedback,
})

export interface PromptSection {
	readonly title: string
	readonly text: string
}

/** The user message: the supervisor's own prompts, global first. */
export const triageMessage = (sections: readonly PromptSection[]) =>
	[
		`Triage every item in the attached snapshot.json. Reply with only the JSON object required by contract version ${TRIAGE_VERSION} and the attached agency-triage-v1.schema.json.`,
		...sections.map(
			(section) => `## ${section.title}\n\n${section.text.trim()}`,
		),
	].join("\n\n")

export const retryMessage = (errors: readonly string[]) =>
	[
		"Your reply did not satisfy the triage contract:",
		...errors.map((error) => `- ${error}`),
		"Reply again with the complete corrected JSON object only.",
	].join("\n")

export const digest = (value: unknown) => sha256(canonical(value))

const decodeResponse = Schema.decodeUnknownResult(TriageResponse, {
	onExcessProperty: "error",
	errors: "all",
})

/** The JSON object in a reply, tolerating Markdown fences and stray prose. */
const extractJson = (text: string): unknown => {
	const trimmed = text
		.trim()
		.replace(/^```(?:json)?\s*\n?/i, "")
		.replace(/\n?```\s*$/, "")
		.trim()
	try {
		return JSON.parse(trimmed)
	} catch {
		const start = trimmed.indexOf("{")
		const end = trimmed.lastIndexOf("}")
		if (start < 0 || end <= start)
			throw new Error("The reply has no JSON object.")
		try {
			return JSON.parse(trimmed.slice(start, end + 1))
		} catch (error) {
			throw new Error(
				`The reply is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}
}

const withoutSubject = ({ subject: _subject, ...rest }: SupervisorAction) =>
	canonical(rest)

const same = (a: unknown, b: unknown) => canonical(a) === canonical(b)

/**
 * Problems with an action the model wrote itself. Agency trusts only what it
 * can check against the item: its own panes, tabs, unit, and the exact argv
 * Agency discovered.
 */
const modelActionErrors = (
	item: TriageItem,
	action: SupervisorAction,
): string[] => {
	const errors: string[] = []
	const where = `Item "${item.key}" action "${action.id}"`
	const refs = [
		...item.panes.map((pane) => ({
			paneId: pane.paneId,
			tabId: pane.tabId,
			workspaceId: pane.workspaceId,
			agentSessionId: pane.agentSessionId,
		})),
		...item.subject.runtime,
	]
	const paneIds = new Set(refs.map((ref) => ref.paneId))
	const tabIds = new Set(refs.flatMap((ref) => (ref.tabId ? [ref.tabId] : [])))
	const workspaceIds = new Set(
		refs.flatMap((ref) => (ref.workspaceId ? [ref.workspaceId] : [])),
	)
	const unit = item.unit?.item.unit ?? null
	const preconditions = action.preconditions
	const hasPaneMatch = (paneId: string) =>
		preconditions.some(
			(condition) =>
				condition.kind === "pane_matches" && condition.paneId === paneId,
		)
	const foreignPane = (paneId: string) => {
		if (!paneIds.has(paneId))
			errors.push(`${where} targets pane ${paneId}, which is not the item's.`)
	}
	const foreignTab = (tabId: string) => {
		if (!tabIds.has(tabId))
			errors.push(`${where} targets tab ${tabId}, which is not the item's.`)
	}

	if (!action.id.startsWith(MODEL_ACTION_PREFIX))
		errors.push(
			`${where} is not a verbatim signal action, so its id must start with "${MODEL_ACTION_PREFIX}".`,
		)

	for (const condition of preconditions as readonly ActionPrecondition[]) {
		if (condition.kind === "pane_matches") {
			foreignPane(condition.paneId)
			foreignTab(condition.tabId)
		} else if (condition.kind === "tab_agent_panes") foreignTab(condition.tabId)
		else if (
			(condition.kind === "item_status" ||
				condition.kind === "item_archived") &&
			condition.unit !== unit
		)
			errors.push(
				`${where} has a precondition on ${condition.unit}, which is not the item's unit.`,
			)
	}

	switch (action.type) {
		case "agency": {
			const payload = action.payload
			const entry = item.agencyActions.find(
				(candidate) => candidate.id === payload.actionId,
			)
			if (!entry) {
				errors.push(
					`${where} uses agency action "${payload.actionId}", which is not in availableAgencyActions.`,
				)
				break
			}
			if (
				!same(payload.command, entry.command) ||
				!same(payload.commandTemplate, entry.commandTemplate)
			)
				errors.push(
					`${where} must copy command and commandTemplate exactly from availableAgencyActions "${entry.id}"; put template input values in values.`,
				)
			if (!same(payload.inputs, entry.inputs))
				errors.push(
					`${where} must copy inputs exactly from availableAgencyActions "${entry.id}".`,
				)
			const inputIds = new Set(entry.inputs.map((input) => input.id))
			for (const id of Object.keys(payload.values))
				if (!inputIds.has(id))
					errors.push(`${where} sets value "${id}", which is not an input.`)
			const selector = item.unit
				? {
						task: item.unit.item.taskId,
						...(item.unit.item.phaseId
							? { phase: item.unit.item.phaseId }
							: {}),
					}
				: null
			if (!same(payload.selector, selector))
				errors.push(`${where} must use the item's selector.`)
			if (payload.cwd !== item.workbase?.ref.root)
				errors.push(`${where} must run from the item's workbase root.`)
			if (payload.bindRuntime) foreignPane(payload.bindRuntime.paneId)
			break
		}
		case "runtime": {
			const { target, id } = action.payload
			if (target === "pane") {
				foreignPane(id)
				if (!hasPaneMatch(id))
					errors.push(`${where} needs a pane_matches precondition for ${id}.`)
			} else if (target === "tab") {
				foreignTab(id)
				if (
					action.payload.operation === "close" &&
					!preconditions.some(
						(condition) =>
							condition.kind === "tab_agent_panes" && condition.tabId === id,
					)
				)
					errors.push(
						`${where} needs a tab_agent_panes precondition for ${id}.`,
					)
			} else if (!workspaceIds.has(id))
				errors.push(
					`${where} targets workspace ${id}, which is not the item's.`,
				)
			break
		}
		case "prompt_agent": {
			const { paneId, agentSessionId } = action.payload
			foreignPane(paneId)
			if (!hasPaneMatch(paneId))
				errors.push(`${where} needs a pane_matches precondition for ${paneId}.`)
			const pane = refs.find((ref) => ref.paneId === paneId)
			if (pane && pane.agentSessionId !== agentSessionId)
				errors.push(`${where} must use pane ${paneId}'s agent session.`)
			break
		}
		case "delegate":
			if (action.payload.unit !== unit)
				errors.push(`${where} delegates a unit that is not the item's.`)
			break
		case "command":
		case "open_url":
			break
	}
	if (action.risk === "read-only")
		errors.push(
			`${where} is written by the model, so its risk cannot be read-only.`,
		)
	return errors
}

/**
 * Validate a reply against the locked contract and the requested items.
 * Every action keeps the item's own subject. An action that is not a verbatim
 * copy of one of the item's signal actions is model-written: it is checked
 * against the item and listed in `modelActionIds`.
 */
export const validateResponse = (
	text: string,
	items: readonly TriageItem[],
):
	| { readonly ok: true; readonly items: ReadonlyMap<string, TriageAssessment> }
	| { readonly ok: false; readonly errors: readonly string[] } => {
	let input: unknown
	try {
		input = extractJson(text)
	} catch (error) {
		return {
			ok: false,
			errors: [error instanceof Error ? error.message : String(error)],
		}
	}
	const decoded = decodeResponse(input)
	if (Result.isFailure(decoded))
		return { ok: false, errors: [decoded.failure.message] }
	const errors: string[] = []
	const byKey = new Map(items.map((item) => [item.key, item]))
	const assessments = new Map<string, TriageAssessment>()
	for (const { key, ...reply } of decoded.success.items) {
		const item = byKey.get(key)
		if (!item) {
			errors.push(`Unknown item key "${key}".`)
			continue
		}
		if (assessments.has(key)) {
			errors.push(`Item key "${key}" appears twice.`)
			continue
		}
		const ids = reply.actions.map((action) => action.id)
		const duplicate = ids.find((id, index) => ids.indexOf(id) !== index)
		if (duplicate)
			errors.push(`Item "${key}" repeats action id "${duplicate}".`)
		const signalActions = new Set(
			item.signals.flatMap((signal) => signal.actions.map(withoutSubject)),
		)
		const modelActionIds: string[] = []
		for (const action of reply.actions) {
			if (signalActions.has(withoutSubject(action))) continue
			modelActionIds.push(action.id)
			errors.push(...modelActionErrors(item, action))
		}
		assessments.set(key, {
			...reply,
			actions: reply.actions.map(
				(action) => ({ ...action, subject: item.subject }) as SupervisorAction,
			),
			modelActionIds,
		})
	}
	for (const item of items) {
		if (!assessments.has(item.key))
			errors.push(`Missing item key "${item.key}".`)
	}
	return errors.length
		? { ok: false, errors }
		: { ok: true, items: assessments }
}

/** Whether a selector names an item: its key, unit, task[/phase], or pane. */
export const matchesItem = (item: TriageItem, selector: string) => {
	if (item.key === selector) return true
	const unit = item.unit?.item
	if (unit) {
		const label = unit.phaseId ? `${unit.taskId}/${unit.phaseId}` : unit.taskId
		if (selector === unit.unit || selector === label) return true
	}
	return item.panes.some(
		(pane) =>
			selector === pane.paneId ||
			selector === `${item.subject.runtime[0]?.runtime}:${pane.paneId}`,
	)
}

export const workbaseRef = (
	workbase: AttentionWorkbase | null,
): AttentionWorkbaseRef | null => workbase?.ref ?? null
