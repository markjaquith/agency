import { basename } from "node:path"
import type {
	AttentionReport,
	AttentionRuntimeRef,
	AttentionSignal,
	AttentionSignalKind,
	AttentionSubject,
	SupervisorAction,
} from "../attention-schema"
import type { Dismissal, Snooze } from "../services/SupervisionStateService"
import type { TriageReportItem } from "../triage-schema"
import {
	dismissalApplies,
	dismissalFingerprint,
	signalFingerprint,
} from "./dismissal"
import type { RuntimeSnapshot } from "./runtime"

export type BadgeTone = "red" | "yellow" | "green" | "blue" | "mauve" | "muted"

interface SuperviseBadge {
	readonly label: string
	readonly tone: BadgeTone
	/** Lower is more urgent. */
	readonly rank: number
}

export interface SuperviseItem {
	/** Stable across refreshes; keys snoozes and dismissals. */
	readonly key: string
	readonly groupKey: string
	readonly badge: SuperviseBadge
	/** The item or pane the entry is about. */
	readonly label: string
	/** Runtime location, such as `Main › alpha`, or null without a pane. */
	readonly location: string | null
	readonly summary: string
	readonly subject: AttentionSubject
	readonly signals: readonly AttentionSignal[]
	/** Ranked, most relevant first: triage's recommendations, then signals'. */
	readonly actions: readonly SupervisorAction[]
	/** Actions the triage model wrote itself rather than copied from a signal. */
	readonly modelActionIds: readonly string[]
	/** Actions triage recommended, model-written or copied from a signal. */
	readonly triageActionIds: readonly string[]
	readonly triage: SuperviseTriage | null
	readonly fingerprints: {
		readonly signal: string
		readonly triage: string | null
	}
	/** `<signal>:<triage>` fingerprints; dismissals pin it. */
	readonly fingerprint: string
}

interface SuperviseTriage {
	readonly source: TriageReportItem["source"]
	readonly evaluatedAt: string | null
	readonly status: string | null
	readonly question: string | null
	readonly error: string | null
}

/**
 * One item's triage result: from a triage run (with its subject) or from the
 * triage cache (without one). Actions must already be decoded.
 */
export type TriageEntry = Omit<TriageReportItem, "subject"> & {
	readonly subject: AttentionSubject | null
}

interface SuperviseGroup {
	readonly key: string
	readonly label: string
	readonly error: string | null
	readonly items: readonly SuperviseItem[]
}

export interface SuperviseModel {
	readonly generatedAt: string
	readonly runtime: AttentionReport["runtime"]
	readonly groups: readonly SuperviseGroup[]
	readonly total: number
	readonly snoozed: number
	readonly dismissed: number
}

export const UNMANAGED_GROUP = "unmanaged"

const evidenceValue = (signal: AttentionSignal, label: string) =>
	signal.evidence.find((item) => item.label === label)?.value ?? null

const badgeFor = (signal: AttentionSignal): SuperviseBadge => {
	const badges: Record<AttentionSignalKind, Omit<SuperviseBadge, "rank">> = {
		agent_waiting:
			evidenceValue(signal, "agentStatus") === "blocked"
				? { label: "Blocked", tone: "red" }
				: { label: "Needs You", tone: "yellow" },
		pr_ready_to_merge: { label: "Ready to Merge", tone: "green" },
		session_cwd_missing: { label: "Lost", tone: "red" },
		pr_merged_item_open: { label: "Merged", tone: "green" },
		complete_session_open: { label: "Done", tone: "green" },
		ticket_status_mismatch: { label: "Needs Ticket", tone: "mauve" },
		claim_without_session: { label: "Stale", tone: "yellow" },
		duplicate_session: { label: "Duplicate", tone: "yellow" },
		unmanaged_session: { label: "Unmanaged", tone: "muted" },
	}
	return ranked(badges[signal.kind])
}

const BADGE_ORDER = [
	"Blocked",
	"Needs You",
	"Ready to Merge",
	"Lost",
	"Merged",
	"Done",
	"Needs Ticket",
	"Stale",
	"Duplicate",
	"In Review",
	"Working",
	"Idle",
	"Unmanaged",
	"Unknown",
]

const ranked = (badge: Omit<SuperviseBadge, "rank">): SuperviseBadge => ({
	...badge,
	rank: BADGE_ORDER.indexOf(badge.label),
})

const TRIAGE_BADGES: Record<string, Omit<SuperviseBadge, "rank"> | null> = {
	needs_input: { label: "Needs You", tone: "yellow" },
	blocked: { label: "Blocked", tone: "red" },
	ready_to_merge: { label: "Ready to Merge", tone: "green" },
	complete: { label: "Done", tone: "green" },
	awaiting_review: { label: "In Review", tone: "blue" },
	in_progress: { label: "Working", tone: "blue" },
	idle: { label: "Idle", tone: "muted" },
	unknown: null,
}

/** Signals scoped as `<kind>:<workbase key>:<unit>[...]`. */
const UNIT_SCOPED = new Set<AttentionSignalKind>([
	"complete_session_open",
	"pr_merged_item_open",
	"pr_ready_to_merge",
	"claim_without_session",
	"agent_waiting",
])

/**
 * Workbase keys (resolved roots) by configured root, learned from unit-scoped
 * signal IDs, so item keys match the keys triage and supervision state use.
 */
const workbaseKeys = (signals: readonly AttentionSignal[]) => {
	const keys = new Map<string, string>()
	for (const signal of signals) {
		const { workbase, item } = signal.subject
		if (!UNIT_SCOPED.has(signal.kind) || !workbase || !item?.unit) continue
		const scope = signal.id.slice(signal.kind.length + 1)
		const end = scope.indexOf(`:${item.unit}`)
		if (end > 0) keys.set(workbase.root, scope.slice(0, end))
	}
	return keys
}

/**
 * An execution unit is keyed `<workbase key>:<unit>`; a pane outside any unit
 * `<runtime>:<pane>`.
 */
const itemKey = (
	signal: AttentionSignal,
	keys: ReadonlyMap<string, string>,
) => {
	const { workbase, item } = signal.subject
	const root = workbase ? (keys.get(workbase.root) ?? workbase.root) : ""
	if (item?.unit) return `${root}:${item.unit}`
	if (item) return `${root}:task:${item.taskId}`
	const pane = signal.subject.runtime[0]
	return pane ? `${pane.runtime}:${pane.paneId}` : signal.id
}

const groupKey = (signal: AttentionSignal) =>
	signal.kind === "unmanaged_session"
		? UNMANAGED_GROUP
		: (signal.subject.workbase?.root ?? UNMANAGED_GROUP)

const workbaseLabel = (workbase: {
	readonly id: string | null
	readonly name: string | null
	readonly root: string
}) => workbase.name ?? workbase.id ?? basename(workbase.root)

const subjectLabel = (subject: AttentionSubject) => {
	if (subject.item)
		return subject.item.phaseId
			? `${subject.item.taskId}/${subject.item.phaseId}`
			: subject.item.taskId
	const pane = subject.runtime[0]
	return pane ? `${pane.agent ?? "pane"} ${pane.paneId}` : "—"
}

const uniqueRefs = (signals: readonly AttentionSignal[]) => {
	const refs = new Map<string, AttentionRuntimeRef>()
	for (const signal of signals)
		for (const ref of signal.subject.runtime)
			if (!refs.has(ref.paneId)) refs.set(ref.paneId, ref)
	return [...refs.values()]
}

/** `Workspace › Tab` for a pane, using runtime labels when known. */
const paneLocation = (
	ref: Pick<AttentionRuntimeRef, "paneId" | "tabId" | "workspaceId">,
	snapshot: RuntimeSnapshot | null,
) => {
	const pane = snapshot?.panes.find((item) => item.paneId === ref.paneId)
	const tabId = pane?.tabId ?? ref.tabId
	const workspaceId = pane?.workspaceId ?? ref.workspaceId
	const workspace = snapshot?.workspaces.find(
		(item) => item.workspaceId === workspaceId,
	)
	const tab = snapshot?.tabs.find((item) => item.tabId === tabId)
	return [workspace?.label ?? workspaceId, tab?.label ?? tabId]
		.filter((part): part is string => Boolean(part))
		.join(" › ")
}

const actionIdentity = (action: SupervisorAction) =>
	JSON.stringify([action.type, action.payload])

const buildItem = (
	key: string,
	signals: readonly AttentionSignal[],
	snapshot: RuntimeSnapshot | null,
): SuperviseItem => {
	const ranked = [...signals].sort(
		(a, b) => badgeFor(a).rank - badgeFor(b).rank,
	)
	const primary = ranked[0]!
	const actions = new Map<string, SupervisorAction>()
	for (const signal of ranked)
		for (const action of signal.actions) {
			const identity = actionIdentity(action)
			if (!actions.has(identity)) actions.set(identity, action)
		}
	const refs = uniqueRefs(ranked)
	const location = locationOf(refs, snapshot)
	return {
		key,
		groupKey: groupKey(primary),
		badge: badgeFor(primary),
		label: subjectLabel(primary.subject),
		location,
		summary:
			ranked.length > 1
				? `${primary.title} (+${ranked.length - 1} more)`
				: primary.title,
		subject: { ...primary.subject, runtime: refs },
		signals: ranked,
		actions: [...actions.values()],
		modelActionIds: [],
		triageActionIds: [],
		triage: null,
		fingerprints: { signal: signalFingerprint(ranked), triage: null },
		fingerprint: dismissalFingerprint(signalFingerprint(ranked), null),
	}
}

const locationOf = (
	refs: readonly AttentionRuntimeRef[],
	snapshot: RuntimeSnapshot | null,
) =>
	refs[0]
		? `${paneLocation(refs[0], snapshot)}${refs.length > 1 ? ` +${refs.length - 1}` : ""}`
		: null

/** An item triage reports without any deterministic signal. */
const triageOnlyItem = (
	entry: TriageEntry & { readonly subject: AttentionSubject },
	snapshot: RuntimeSnapshot | null,
): SuperviseItem => ({
	key: entry.key,
	groupKey: entry.subject.workbase?.root ?? UNMANAGED_GROUP,
	badge: ranked({ label: "Unknown", tone: "muted" }),
	label: subjectLabel(entry.subject),
	location: locationOf(entry.subject.runtime, snapshot),
	summary: entry.error ?? "Not yet assessed",
	subject: entry.subject,
	signals: [],
	actions: [],
	modelActionIds: [],
	triageActionIds: [],
	triage: null,
	fingerprints: { signal: "", triage: entry.fingerprint },
	fingerprint: dismissalFingerprint("", entry.fingerprint),
})

/** Layer a triage result over an item; triage's actions rank first. */
const withTriage = (item: SuperviseItem, entry: TriageEntry): SuperviseItem => {
	const assessment = entry.assessment
	const triage: SuperviseTriage = {
		source: entry.source,
		evaluatedAt: entry.evaluatedAt,
		status: assessment?.status ?? null,
		question: assessment?.question ?? null,
		error: entry.error,
	}
	const fingerprints = {
		signal: item.fingerprints.signal,
		triage: entry.fingerprint,
	}
	const fingerprint = dismissalFingerprint(
		fingerprints.signal,
		fingerprints.triage,
	)
	if (!assessment) return { ...item, triage, fingerprints, fingerprint }
	// Triage ranks first, but a signal's own copy of an action always wins a
	// collision, keeping its preconditions and risk.
	const signalActions = new Map(
		item.actions.map((action) => [actionIdentity(action), action]),
	)
	const actions = new Map<string, SupervisorAction>()
	for (const action of [...assessment.actions, ...item.actions]) {
		const identity = actionIdentity(action)
		if (!actions.has(identity))
			actions.set(identity, signalActions.get(identity) ?? action)
	}
	const kept = new Set([...actions.values()].map((action) => action.id))
	const signalIds = new Set(item.actions.map((action) => action.id))
	const triageBadge = TRIAGE_BADGES[assessment.status]
	const badge =
		triageBadge &&
		(item.signals.length === 0 || ranked(triageBadge).rank < item.badge.rank)
			? ranked(triageBadge)
			: item.badge
	return {
		...item,
		badge,
		summary: assessment.question
			? `${assessment.summary} — asks: ${assessment.question}`
			: assessment.summary,
		actions: [...actions.values()],
		modelActionIds: assessment.modelActionIds.filter(
			(id) => kept.has(id) && !signalIds.has(id),
		),
		triageActionIds: assessment.actions.flatMap((action) => {
			const winner = actions.get(actionIdentity(action))
			return winner ? [winner.id] : []
		}),
		triage,
		fingerprints,
		fingerprint,
	}
}

export interface HiddenState {
	readonly snoozes: readonly Snooze[]
	readonly dismissals: readonly Dismissal[]
}

const snoozed = (
	snooze: Snooze,
	key: string,
	actionId: string | null,
	now: Date,
) =>
	snooze.key === key &&
	snooze.actionId === actionId &&
	Date.parse(snooze.until) > now.getTime()

const dismissed = (
	dismissal: Dismissal,
	key: string,
	actionId: string | null,
	fingerprints: SuperviseItem["fingerprints"],
) =>
	dismissal.key === key &&
	dismissal.actionId === actionId &&
	dismissalApplies(dismissal.fingerprint, fingerprints)

const isHidden = (
	item: Pick<SuperviseItem, "key" | "fingerprints">,
	state: HiddenState,
	now: Date,
): "snoozed" | "dismissed" | null => {
	if (state.snoozes.some((entry) => snoozed(entry, item.key, null, now)))
		return "snoozed"
	if (
		state.dismissals.some((entry) =>
			dismissed(entry, item.key, null, item.fingerprints),
		)
	)
		return "dismissed"
	return null
}

/** Drop individually snoozed or dismissed actions. */
const visibleActions = (
	item: SuperviseItem,
	state: HiddenState,
	now: Date,
): SuperviseItem => ({
	...item,
	actions: item.actions.filter(
		(action) =>
			!state.snoozes.some((entry) =>
				snoozed(entry, item.key, action.id, now),
			) &&
			!state.dismissals.some((entry) =>
				dismissed(entry, item.key, action.id, item.fingerprints),
			),
	),
})

/** Group attention signals into supervised items by workbase. */
export const superviseModel = (
	report: AttentionReport,
	options: {
		readonly snapshot?: RuntimeSnapshot | null
		readonly state: HiddenState
		readonly now?: Date
		/** Triage results by item key. */
		readonly triage?: ReadonlyMap<string, TriageEntry>
	},
): SuperviseModel => {
	const now = options.now ?? new Date()
	const keys = workbaseKeys(report.signals)
	const bySubject = new Map<string, AttentionSignal[]>()
	for (const signal of report.signals) {
		const key = itemKey(signal, keys)
		bySubject.set(key, [...(bySubject.get(key) ?? []), signal])
	}
	let snoozedCount = 0
	let dismissedCount = 0
	const items: SuperviseItem[] = []
	const snapshot = options.snapshot ?? null
	const triage = options.triage ?? new Map<string, TriageEntry>()
	const candidates = [
		...[...bySubject].map(([key, signals]) =>
			buildItem(key, signals, snapshot),
		),
		...[...triage.values()].flatMap((entry) =>
			entry.subject && !bySubject.has(entry.key)
				? [triageOnlyItem({ ...entry, subject: entry.subject }, snapshot)]
				: [],
		),
	]
	for (const candidate of candidates) {
		const entry = triage.get(candidate.key)
		const item = entry ? withTriage(candidate, entry) : candidate
		// Hiding follows live snooze and dismissal state, never a triage run's
		// possibly stale `suppressed` value.
		const hidden = isHidden(item, options.state, now)
		if (hidden === "snoozed") snoozedCount++
		else if (hidden === "dismissed") dismissedCount++
		else items.push(visibleActions(item, options.state, now))
	}
	const groups: SuperviseGroup[] = [
		...report.workbases.map((workbase) => ({
			key: workbase.root,
			label: workbaseLabel(workbase),
			error: workbase.error,
		})),
		{ key: UNMANAGED_GROUP, label: "Unmanaged", error: null },
	]
		.map((group) => ({
			...group,
			items: items
				.filter((item) => item.groupKey === group.key)
				.sort(
					(a, b) =>
						a.badge.rank - b.badge.rank || a.label.localeCompare(b.label),
				),
		}))
		.filter((group) => group.items.length > 0 || group.error)
	// Signals may name a workbase that the report does not list.
	const listed = new Set(groups.map((group) => group.key))
	const orphans = items.filter((item) => !listed.has(item.groupKey))
	for (const key of [...new Set(orphans.map((item) => item.groupKey))]) {
		const sample = orphans.find((item) => item.groupKey === key)!
		const at =
			groups.at(-1)?.key === UNMANAGED_GROUP ? groups.length - 1 : groups.length
		groups.splice(at, 0, {
			key,
			label: sample.subject.workbase
				? workbaseLabel(sample.subject.workbase)
				: basename(key),
			error: null,
			items: orphans.filter((item) => item.groupKey === key),
		})
	}
	return {
		generatedAt: report.generatedAt,
		runtime: report.runtime,
		groups,
		total: items.length,
		snoozed: snoozedCount,
		dismissed: dismissedCount,
	}
}
