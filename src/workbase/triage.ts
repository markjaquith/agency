import { Result, Schema } from "effect"
import { createHash } from "node:crypto"
import type {
	AttentionSignal,
	AttentionSubject,
	AttentionWorkbaseRef,
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
} from "./attention"
import type { RuntimeAgentStatus, RuntimePane } from "./runtime"

const WAITING = new Set<RuntimeAgentStatus>(["idle", "done", "blocked"])
export const TRANSCRIPT_LINES = 120
const TRANSCRIPT_CHARS = 6000

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
}

export interface TranscriptTail {
	readonly paneId: string
	readonly text: string
}

const sha256 = (value: string) =>
	createHash("sha256").update(value).digest("hex")

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
			})
		}
	}
	const paneItems = new Map<string, TriageItem>()
	for (const signal of signals) {
		if (signal.subject.item) continue
		const ref = signal.subject.runtime[0]
		if (!ref) continue
		const key = `${ref.runtime}:${ref.paneId}`
		const existing = paneItems.get(key)
		if (existing) {
			paneItems.set(key, {
				...existing,
				signals: [...existing.signals, signal],
			})
			continue
		}
		const root = signal.subject.workbase?.root
		paneItems.set(key, {
			key,
			workbase:
				(root &&
					snapshot.workbases.find((workbase) =>
						workbase.roots.includes(root),
					)) ||
				null,
			unit: null,
			panes: snapshot.runtime.panes
				.filter((pane) =>
					signal.subject.runtime.some((item) => item.paneId === pane.paneId),
				)
				.map((pane) => ({ ...pane, binding: null })),
			signals: [signal],
			subject: signal.subject,
		})
	}
	return [...items, ...paneItems.values()]
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
	terminalTitle: pane.terminalTitle,
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

const signalFacts = (signal: AttentionSignal) => ({
	id: signal.id,
	kind: signal.kind,
	title: signal.title,
	evidence: signal.evidence,
	actions: signal.actions,
})

/**
 * A digest of everything triage judges an item on. An unchanged fingerprint
 * means a cached assessment still applies.
 */
export const itemFingerprint = (
	item: TriageItem,
	transcripts: readonly TranscriptTail[],
	promptDigest: string,
) =>
	sha256(
		JSON.stringify({
			contract: TRIAGE_VERSION,
			prompt: promptDigest,
			key: item.key,
			unit: item.unit ? unitFacts(item.unit) : null,
			pullRequest: pullRequestFacts(item.unit),
			ticket: item.unit?.ticket ?? null,
			panes: item.panes.map(paneFacts),
			signals: item.signals.map(signalFacts),
			transcripts: transcripts.map((tail) => ({
				paneId: tail.paneId,
				sha256: sha256(tail.text),
			})),
		}),
	)

/** The structured snapshot entry the triage agent sees for one item. */
export const itemSnapshot = (
	item: TriageItem,
	transcripts: readonly TranscriptTail[],
	previous: TriageAssessment | null,
) => ({
	key: item.key,
	subject: item.subject,
	item: item.unit ? unitFacts(item.unit) : null,
	pullRequest: pullRequestFacts(item.unit),
	ticket: item.unit?.ticket ?? null,
	panes: item.panes.map(paneFacts),
	signals: item.signals.map(signalFacts),
	availableAgencyActions: (item.unit?.actions ?? [])
		.filter((action) => action.available)
		.map(({ id, label, command, commandTemplate, inputs }) => ({
			id,
			label,
			command,
			commandTemplate,
			inputs,
		})),
	agencyCwd: item.workbase?.ref.root ?? null,
	transcriptTails: transcripts,
	previousAssessment: previous,
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

export const promptDigest = (sections: readonly PromptSection[]) =>
	sha256(JSON.stringify(sections))

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

/**
 * Validate a reply against the locked contract and the requested keys.
 * Returns assessments by key, or every validation error.
 */
export const validateResponse = (
	text: string,
	keys: readonly string[],
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
	const expected = new Set(keys)
	const items = new Map<string, TriageAssessment>()
	for (const { key, ...assessment } of decoded.success.items) {
		if (!expected.has(key)) errors.push(`Unknown item key "${key}".`)
		else if (items.has(key)) errors.push(`Item key "${key}" appears twice.`)
		else {
			const ids = assessment.actions.map((action) => action.id)
			const duplicate = ids.find((id, index) => ids.indexOf(id) !== index)
			if (duplicate)
				errors.push(`Item "${key}" repeats action id "${duplicate}".`)
			items.set(key, assessment)
		}
	}
	for (const key of keys) {
		if (!items.has(key)) errors.push(`Missing item key "${key}".`)
	}
	return errors.length ? { ok: false, errors } : { ok: true, items }
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
