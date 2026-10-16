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
	/** Ranked, most relevant first. */
	readonly actions: readonly SupervisorAction[]
	/** Changes whenever the item's signals change; dismissals pin it. */
	readonly fingerprint: string
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

/**
 * Judgment layered over deterministic items, such as LLM triage results.
 * Annotation actions rank ahead of signal actions.
 */
interface ItemAnnotation {
	readonly badge?: string
	readonly summary?: string
	readonly actions?: readonly SupervisorAction[]
}

export type Annotate = (item: SuperviseItem) => ItemAnnotation | null

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
	const order = [
		"Blocked",
		"Needs You",
		"Ready to Merge",
		"Lost",
		"Merged",
		"Done",
		"Needs Ticket",
		"Stale",
		"Duplicate",
		"Unmanaged",
	]
	const badge = badges[signal.kind]
	return { ...badge, rank: order.indexOf(badge.label) }
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

const fingerprintOf = (signals: readonly AttentionSignal[]) =>
	new Bun.CryptoHasher("sha256")
		.update(
			signals
				.map((signal) => `${signal.id}\u0000${signal.title}`)
				.sort()
				.join("\u0001"),
		)
		.digest("hex")
		.slice(0, 16)

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
	const location = refs[0]
		? `${paneLocation(refs[0], snapshot)}${refs.length > 1 ? ` +${refs.length - 1}` : ""}`
		: null
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
		fingerprint: fingerprintOf(ranked),
	}
}

const annotated = (item: SuperviseItem, annotate?: Annotate): SuperviseItem => {
	const annotation = annotate?.(item)
	if (!annotation) return item
	const actions = new Map<string, SupervisorAction>()
	for (const action of [...(annotation.actions ?? []), ...item.actions]) {
		const identity = actionIdentity(action)
		if (!actions.has(identity)) actions.set(identity, action)
	}
	return {
		...item,
		badge: annotation.badge
			? { ...item.badge, label: annotation.badge }
			: item.badge,
		summary: annotation.summary ?? item.summary,
		actions: [...actions.values()],
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
	fingerprint: string,
) =>
	dismissal.key === key &&
	dismissal.actionId === actionId &&
	(dismissal.fingerprint === null || dismissal.fingerprint === fingerprint)

const isHidden = (
	item: Pick<SuperviseItem, "key" | "fingerprint">,
	state: HiddenState,
	now: Date,
): "snoozed" | "dismissed" | null => {
	if (state.snoozes.some((entry) => snoozed(entry, item.key, null, now)))
		return "snoozed"
	if (
		state.dismissals.some((entry) =>
			dismissed(entry, item.key, null, item.fingerprint),
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
				dismissed(entry, item.key, action.id, item.fingerprint),
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
		readonly annotate?: Annotate
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
	for (const [key, signals] of bySubject) {
		const item = annotated(
			buildItem(key, signals, options.snapshot ?? null),
			options.annotate,
		)
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
