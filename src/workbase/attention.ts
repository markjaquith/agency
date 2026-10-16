import { isAbsolute, join, relative, sep } from "node:path"
import {
	ACTION_VERSION,
	type ActionPrecondition,
	type ActionRisk,
	type AttentionEvidence,
	type AttentionItemRef,
	type AttentionRuntimeRef,
	type AttentionSignal,
	type AttentionSignalKind,
	type AttentionSubject,
	type AttentionWorkbaseRef,
	type SupervisorAction,
} from "../attention-schema"
import type { LivePullRequest } from "../services/PullRequestStatusService"
import type { TicketRecord } from "../tickets/provider"
import type { RuntimeAgentStatus, RuntimeKind, RuntimePane } from "./runtime"
import type { InferredBinding, RuntimeBinding } from "./runtime-bindings"
import type { WorkStatus } from "./schemas"

/** An `agency act` catalog entry, as reported by its JSON discovery. */
export interface CatalogAction {
	readonly id: string
	readonly label: string
	readonly available: boolean
	readonly blockedReason: string | null
	readonly command: readonly string[] | null
	readonly commandTemplate: readonly string[] | null
	readonly inputs: readonly {
		readonly id: string
		readonly label: string
		readonly required: boolean
		readonly multiline?: boolean
		readonly option?: string
	}[]
}

export interface AttentionPullRequest {
	readonly url: string
	readonly repository: string | null
	readonly recordedState: "open" | "closed" | "merged"
	readonly live: LivePullRequest | null
	/** The merge argv, present only when the PR is ready to merge. */
	readonly mergeCommand: readonly string[] | null
}

interface AttentionBinding {
	readonly record: RuntimeBinding
	readonly state: "live" | "moved" | "duplicated" | "gone" | "unknown"
	readonly panes: readonly RuntimePane[]
}

export interface AttentionUnit {
	readonly item: AttentionItemRef & { readonly unit: string }
	/** For a phase, its task document, which owns the ticket. */
	readonly parent: {
		readonly path: string
		readonly revision: string | null
	} | null
	/** A review task, which finishes instead of delivering a PR. */
	readonly review: boolean
	readonly status: WorkStatus
	readonly revision: string | null
	readonly pr: AttentionPullRequest | null
	readonly ticket: TicketRecord
	readonly binding: AttentionBinding | null
	readonly inferred: readonly Pick<InferredBinding, "matchedBy" | "pane">[]
	readonly actions: readonly CatalogAction[]
}

export interface AttentionWorkbase {
	readonly ref: AttentionWorkbaseRef
	/** The root as configured and as resolved through symlinks. */
	readonly roots: readonly string[]
	/** A stable key (the resolved root) for signal IDs. */
	readonly key: string
	/** Why the workbase is supervised: registered, the current directory, or a live pane. */
	readonly source: "registered" | "current" | "runtime"
	readonly isDefault: boolean
	readonly error: string | null
	/** Status names for suggested Jira transitions. */
	readonly jira: { readonly doneStatus: string; readonly reopenStatus: string }
	readonly units: readonly AttentionUnit[]
	/** Workbase-level `agency act` actions, such as task creation. */
	readonly actions: readonly CatalogAction[]
	/** Panes claimed by any binding or inference in this workbase. */
	readonly claimedPaneIds: readonly string[]
}

export interface AttentionSnapshot {
	readonly runtime: {
		readonly provider: RuntimeKind | null
		readonly available: boolean
		readonly error: string | null
		readonly panes: readonly RuntimePane[]
	}
	readonly workbases: readonly AttentionWorkbase[]
	/** Roots of other known workbases that are not inspected in this run. */
	readonly otherRoots: readonly string[]
	/** Pane working directories that no longer exist. */
	readonly missingPaths: readonly string[]
}

const SIGNAL_ORDER: readonly AttentionSignalKind[] = [
	"complete_session_open",
	"ticket_status_mismatch",
	"pr_merged_item_open",
	"pr_ready_to_merge",
	"claim_without_session",
	"duplicate_session",
	"session_cwd_missing",
	"agent_waiting",
	"unmanaged_session",
]

const TERMINAL = new Set<WorkStatus>(["done", "dropped"])
const ACTIVE: readonly WorkStatus[] = ["open", "working", "delegated"]
const WAITING = new Set<RuntimeAgentStatus>(["idle", "done", "blocked"])
const ANY_STATUS: readonly RuntimeAgentStatus[] = [
	"idle",
	"working",
	"blocked",
	"done",
	"unknown",
]
/** Agent states in which closing a pane cannot interrupt work in progress. */
const CLOSABLE: readonly RuntimeAgentStatus[] = ["idle", "done", "blocked"]
const MERGEABLE_STATES = new Set(["CLEAN", "HAS_HOOKS"])

const contains = (parent: string, path: string) => {
	const relation = relative(parent, path)
	return (
		relation === "" ||
		(!isAbsolute(relation) &&
			relation !== ".." &&
			!relation.startsWith(`..${sep}`))
	)
}

const effectivePullRequestState = (pr: AttentionPullRequest) =>
	pr.live?.state === "available" ? pr.live.prState : pr.recordedState

/**
 * Approved, with checks that ran and passed, and a clean merge state for a
 * known head commit. No checks at all is not green: it is normal just after a
 * push, before checks register.
 */
export const isReadyToMerge = (live: LivePullRequest | null) =>
	live?.state === "available" &&
	live.prState === "open" &&
	!live.draft &&
	live.review === "approved" &&
	live.checks === "passing" &&
	live.mergeable !== "conflicting" &&
	live.mergeState !== null &&
	MERGEABLE_STATES.has(live.mergeState) &&
	live.headSha !== null

const paneCwd = (pane: RuntimePane) => pane.foregroundCwd ?? pane.cwd

const runtimeRef = (
	runtime: RuntimeKind,
	pane: RuntimePane,
): AttentionRuntimeRef => ({
	runtime,
	paneId: pane.paneId,
	tabId: pane.tabId,
	workspaceId: pane.workspaceId,
	agent: pane.agent,
	agentSessionId: pane.agentSessionId,
})

const subjectFor = (
	workbase: AttentionWorkbase | null,
	unit: AttentionUnit | null,
	panes: readonly AttentionRuntimeRef[] = [],
): AttentionSubject => ({
	workbase: workbase?.ref ?? null,
	item: unit?.item ?? null,
	runtime: panes,
	pullRequest: unit?.pr ? { url: unit.pr.url } : null,
	ticket:
		unit && unit.ticket.state !== "none"
			? {
					url: unit.ticket.url,
					key: "key" in unit.ticket ? unit.ticket.key : null,
				}
			: null,
})

interface UnitPane {
	readonly pane: RuntimePane
	readonly binding: "recorded" | "inferred"
	readonly matchedBy: "checkout" | "directory" | null
}

/** Panes that currently host a unit through its binding or an inference. */
const unitPanes = (unit: AttentionUnit): UnitPane[] => {
	const panes = new Map<string, UnitPane>()
	if (
		unit.binding &&
		unit.binding.state !== "gone" &&
		unit.binding.state !== "unknown"
	) {
		for (const pane of unit.binding.panes)
			panes.set(pane.paneId, { pane, binding: "recorded", matchedBy: null })
	}
	for (const inferred of unit.inferred) {
		if (!panes.has(inferred.pane.paneId))
			panes.set(inferred.pane.paneId, {
				pane: inferred.pane,
				binding: "inferred",
				matchedBy: inferred.matchedBy,
			})
	}
	return [...panes.values()].sort((a, b) =>
		a.pane.paneId.localeCompare(b.pane.paneId),
	)
}

const evidence = (
	source: AttentionEvidence["source"],
	label: string,
	value: AttentionEvidence["value"],
	about: Pick<AttentionEvidence, "unit" | "phaseId" | "paneId"> = {},
): AttentionEvidence => ({ source, label, value, ...about })

const unitAbout = (unit: AttentionUnit) => ({
	unit: unit.item.unit,
	...(unit.item.phaseId ? { phaseId: unit.item.phaseId } : {}),
})

const unitEvidence = (
	unit: AttentionUnit,
	about: Pick<AttentionEvidence, "unit" | "phaseId"> = {},
): AttentionEvidence[] => [
	evidence("agency", "status", unit.status, about),
	evidence("agency", "archived", unit.item.archived, about),
]

const prEvidence = (
	pr: AttentionPullRequest | null,
	about: Pick<AttentionEvidence, "unit" | "phaseId"> = {},
): AttentionEvidence[] => {
	if (!pr) return [evidence("pull_request", "state", "none", about)]
	const items = [
		evidence("pull_request", "url", pr.url, about),
		evidence("pull_request", "state", effectivePullRequestState(pr), about),
		evidence(
			"pull_request",
			"source",
			pr.live?.state === "available" ? "live" : "recorded",
			about,
		),
	]
	if (pr.live?.state === "available") {
		items.push(
			evidence("pull_request", "draft", pr.live.draft, about),
			evidence("pull_request", "review", pr.live.review, about),
			evidence("pull_request", "checks", pr.live.checks, about),
			evidence("pull_request", "mergeable", pr.live.mergeable, about),
			evidence("pull_request", "mergeState", pr.live.mergeState, about),
			evidence("pull_request", "headSha", pr.live.headSha, about),
		)
	} else if (pr.live?.state === "unavailable") {
		items.push(evidence("pull_request", "liveError", pr.live.reason, about))
	}
	return items
}

const ticketEvidence = (ticket: TicketRecord): AttentionEvidence[] => {
	switch (ticket.state) {
		case "none":
			return [evidence("ticket", "state", "none")]
		case "available":
			return [
				evidence("ticket", "key", ticket.key),
				evidence("ticket", "status", ticket.status),
				evidence("ticket", "statusCategory", ticket.statusCategory),
			]
		default:
			return [
				evidence("ticket", "state", ticket.state),
				evidence("ticket", "reason", ticket.reason),
			]
	}
}

const paneEvidence = (
	pane: RuntimePane,
	provenance?: Pick<UnitPane, "binding" | "matchedBy">,
): AttentionEvidence[] => {
	const about = { paneId: pane.paneId }
	return [
		evidence("runtime", "paneId", pane.paneId, about),
		evidence("runtime", "tabId", pane.tabId, about),
		evidence("runtime", "agent", pane.agent, about),
		evidence("runtime", "agentSessionId", pane.agentSessionId, about),
		evidence("runtime", "agentStatus", pane.agentStatus, about),
		evidence("runtime", "cwd", paneCwd(pane), about),
		...(provenance
			? [
					evidence("runtime", "binding", provenance.binding, about),
					evidence("runtime", "matchedBy", provenance.matchedBy, about),
				]
			: []),
	]
}

interface ActionBase {
	readonly slug: string
	readonly title: string
	readonly rationale: string
	readonly risk: ActionRisk
	readonly subject: AttentionSubject
	readonly preconditions: readonly ActionPrecondition[]
}

type ActionPayloads = {
	[T in SupervisorAction["type"]]: Extract<
		SupervisorAction,
		{ readonly type: T }
	>["payload"]
}

const makeAction = <T extends SupervisorAction["type"]>(
	signalId: string,
	type: T,
	base: ActionBase,
	payload: ActionPayloads[T],
): SupervisorAction =>
	({
		version: ACTION_VERSION,
		id: `${signalId}/${base.slug}`,
		type,
		title: base.title,
		rationale: base.rationale,
		risk: base.risk,
		subject: base.subject,
		preconditions: base.preconditions,
		payload,
	}) as SupervisorAction

const unitPreconditions = (
	unit: AttentionUnit,
	statuses: readonly WorkStatus[],
): ActionPrecondition[] => [
	{ kind: "item_archived", unit: unit.item.unit, archived: unit.item.archived },
	...(unit.item.archived
		? []
		: [
				{ kind: "item_status", unit: unit.item.unit, statuses } as const,
				...(unit.revision
					? [
							{
								kind: "document_revision",
								path: unit.item.path,
								sha256: unit.revision,
							} as const,
						]
					: []),
			]),
]

const paneMatches = (
	runtime: RuntimeKind,
	pane: RuntimePane,
	agentStatuses: readonly RuntimeAgentStatus[],
): ActionPrecondition => ({
	kind: "pane_matches",
	runtime,
	paneId: pane.paneId,
	tabId: pane.tabId,
	cwd: paneCwd(pane),
	agentSessionId: pane.agentSessionId,
	agentStatuses,
})

const agencyAction = (
	signalId: string,
	workbase: AttentionWorkbase,
	catalog: readonly CatalogAction[],
	actionId: string,
	base: Omit<ActionBase, "slug" | "title"> & {
		readonly title?: string
		readonly slug?: string
	},
	unit: AttentionUnit | null,
	bindRuntime: AttentionRuntimeRef | null = null,
): SupervisorAction[] => {
	const entry = catalog.find((action) => action.id === actionId)
	if (!entry?.available) return []
	const argv = entry.command
		? { command: entry.command, commandTemplate: null }
		: entry.commandTemplate
			? { command: null, commandTemplate: entry.commandTemplate }
			: null
	if (!argv) return []
	return [
		makeAction(
			signalId,
			"agency",
			{
				...base,
				slug: base.slug ?? actionId,
				title: base.title ?? entry.label,
			},
			{
				actionId,
				selector: unit
					? {
							task: unit.item.taskId,
							...(unit.item.phaseId ? { phase: unit.item.phaseId } : {}),
						}
					: null,
				...argv,
				inputs: entry.inputs,
				values: {},
				cwd: workbase.ref.root,
				bindRuntime,
			} as ActionPayloads["agency"],
		),
	]
}

const focusAction = (
	signalId: string,
	runtime: RuntimeKind,
	pane: RuntimePane,
	subject: AttentionSubject,
): SupervisorAction =>
	makeAction(
		signalId,
		"runtime",
		{
			slug: `focus-pane-${pane.paneId}`,
			title: `Focus pane ${pane.paneId}`,
			rationale: "Look at the session before deciding what to do with it.",
			risk: "reversible",
			subject,
			preconditions: [paneMatches(runtime, pane, ANY_STATUS)],
		},
		{ runtime, operation: "focus", target: "pane", id: pane.paneId },
	)

const closePaneAction = (
	signalId: string,
	runtime: RuntimeKind,
	pane: RuntimePane,
	subject: AttentionSubject,
	title: string,
	rationale: string,
	preconditions: readonly ActionPrecondition[],
): SupervisorAction =>
	makeAction(
		signalId,
		"runtime",
		{
			slug: `close-pane-${pane.paneId}`,
			title,
			rationale,
			risk: "destructive",
			subject,
			preconditions: [...preconditions, paneMatches(runtime, pane, CLOSABLE)],
		},
		{ runtime, operation: "close", target: "pane", id: pane.paneId },
	)

/**
 * Close whole tabs when every agent pane in them is one of `panes` (the rest,
 * such as an editor, belong with them); otherwise close individual panes. Only
 * agents that are not working are closed.
 */
const closeActions = (
	signalId: string,
	snapshot: AttentionSnapshot,
	panes: readonly RuntimePane[],
	subject: AttentionSubject,
	rationale: string,
	extraPreconditions: readonly ActionPrecondition[] = [],
): SupervisorAction[] => {
	const runtime = snapshot.runtime.provider
	if (!runtime) return []
	const closable = panes.filter((pane) => CLOSABLE.includes(pane.agentStatus))
	const ids = new Set(closable.map((pane) => pane.paneId))
	const tabs = [...new Set(closable.map((pane) => pane.tabId))].sort()
	return tabs.flatMap((tabId) => {
		const inTab = closable.filter((pane) => pane.tabId === tabId)
		const tabAgents = snapshot.runtime.panes
			.filter((pane) => pane.tabId === tabId && pane.agent !== null)
			.map((pane) => pane.paneId)
			.sort()
		if (tabAgents.every((paneId) => ids.has(paneId))) {
			return [
				makeAction(
					signalId,
					"runtime",
					{
						slug: `close-tab-${tabId}`,
						title: `Close tab ${tabId}`,
						rationale,
						risk: "destructive",
						subject,
						preconditions: [
							...extraPreconditions,
							{ kind: "tab_agent_panes", runtime, tabId, paneIds: tabAgents },
							...inTab.map((pane) => paneMatches(runtime, pane, CLOSABLE)),
						],
					},
					{ runtime, operation: "close", target: "tab", id: tabId },
				),
			]
		}
		return inTab.map((pane) =>
			closePaneAction(
				signalId,
				runtime,
				pane,
				subject,
				`Close pane ${pane.paneId}`,
				rationale,
				extraPreconditions,
			),
		)
	})
}

const openUrlAction = (
	signalId: string,
	slug: string,
	title: string,
	url: string,
	subject: AttentionSubject,
): SupervisorAction =>
	makeAction(
		signalId,
		"open_url",
		{
			slug,
			title,
			rationale: "Inspect the external record.",
			risk: "read-only",
			subject,
			preconditions: [],
		},
		{ url },
	)

/** Explicit provider transition argv; transitions are never automatic. */
const ticketTransition = (
	ticket: Extract<TicketRecord, { state: "available" }>,
	target: "done" | "reopen",
	jira: AttentionWorkbase["jira"],
): { readonly argv: readonly string[]; readonly title: string } | null => {
	if (ticket.provider === "jira") {
		const status = target === "reopen" ? jira.reopenStatus : jira.doneStatus
		return {
			argv: [
				"acli",
				"jira",
				"workitem",
				"transition",
				"--key",
				ticket.key,
				"--status",
				status,
				"--yes",
			],
			title: `Transition ${ticket.key} to ${status}`,
		}
	}
	if (ticket.provider === "github") {
		return target === "reopen"
			? {
					argv: ["gh", "issue", "reopen", ticket.url],
					title: `Reopen ${ticket.key}`,
				}
			: {
					argv: ["gh", "issue", "close", ticket.url, "--reason", "completed"],
					title: `Close ${ticket.key} as completed`,
				}
	}
	return null
}

const signal = (
	kind: AttentionSignalKind,
	scope: string,
	title: string,
	subject: AttentionSubject,
	evidenceItems: readonly AttentionEvidence[],
	actions: (id: string) => readonly SupervisorAction[],
): AttentionSignal => {
	const id = `${kind}:${scope}`
	return {
		id,
		kind,
		title,
		subject,
		evidence: evidenceItems,
		actions: actions(id),
	}
}

const unitScope = (workbase: AttentionWorkbase, unit: AttentionUnit) =>
	`${workbase.key}:${unit.item.unit}`

const unitLabel = (unit: AttentionUnit) =>
	unit.item.phaseId
		? `${unit.item.taskId}/${unit.item.phaseId}`
		: unit.item.taskId

const completeSessionOpen = (
	snapshot: AttentionSnapshot,
	workbase: AttentionWorkbase,
	unit: AttentionUnit,
): AttentionSignal[] => {
	const runtime = snapshot.runtime.provider
	const entries = unitPanes(unit)
	if (!runtime || entries.length === 0) return []
	if (!TERMINAL.has(unit.status) && !unit.item.archived) return []
	const prState = unit.pr ? effectivePullRequestState(unit.pr) : null
	// Dropped work may legitimately end with a closed, unmerged PR.
	const prSettled =
		prState === null ||
		prState === "merged" ||
		(prState === "closed" && unit.status === "dropped")
	const ticketSettled =
		unit.ticket.state === "none" ||
		(unit.ticket.state === "available" && unit.ticket.statusCategory === "done")
	if (!prSettled || !ticketSettled) return []
	const panes = entries.map((entry) => entry.pane)
	const subject = subjectFor(
		workbase,
		unit,
		panes.map((pane) => runtimeRef(runtime, pane)),
	)
	const state = unit.item.archived ? "archived" : unit.status
	const preconditions: ActionPrecondition[] = unit.item.archived
		? [{ kind: "item_archived", unit: unit.item.unit, archived: true }]
		: unitPreconditions(unit, ["done", "dropped"])
	return [
		signal(
			"complete_session_open",
			unitScope(workbase, unit),
			`${unitLabel(unit)} is ${state} but its session is still open`,
			subject,
			[
				...unitEvidence(unit),
				...prEvidence(unit.pr),
				...ticketEvidence(unit.ticket),
				...entries.flatMap((entry) => paneEvidence(entry.pane, entry)),
			],
			(id) => [
				...closeActions(
					id,
					snapshot,
					panes,
					subject,
					"The work is complete; its session no longer needs supervision.",
					preconditions,
				),
				...panes.map((pane) => focusAction(id, runtime, pane, subject)),
				...(unit.item.archived
					? []
					: agencyAction(
							id,
							workbase,
							unit.actions,
							"archive",
							{
								rationale:
									"Terminal work can move to the archive once its session closes.",
								risk: "reversible",
								subject,
								preconditions,
							},
							unit,
						)),
			],
		),
	]
}

interface Member {
	readonly workbase: AttentionWorkbase
	readonly unit: AttentionUnit
}

const mergedPr = (unit: AttentionUnit) =>
	unit.pr !== null && effectivePullRequestState(unit.pr) === "merged"

/**
 * One ticket may be shared by several units (phases, or follow-up tasks). It
 * is delivered only when every sharing unit is terminal, at least one is done
 * with a merged PR, and none is done with an unmerged PR.
 */
const ticketStatusMismatch = (
	ticket: Extract<TicketRecord, { state: "available" }>,
	members: readonly Member[],
): AttentionSignal[] => {
	const first = members[0]!
	const units = members.map((member) => member.unit)
	const delivered =
		units.every((unit) => TERMINAL.has(unit.status)) &&
		units.some((unit) => unit.status === "done" && mergedPr(unit)) &&
		units.every(
			(unit) => unit.status !== "done" || unit.pr === null || mergedPr(unit),
		)
	const active = units.filter(
		(unit) => !unit.item.archived && ACTIVE.includes(unit.status),
	)
	// A done ticket is consistent with active follow-up work once any sharing
	// unit has been completed.
	const reopened =
		ticket.statusCategory === "done" &&
		active.length > 0 &&
		!units.some((unit) => unit.status === "done")
	const forward = delivered && ticket.statusCategory !== "done"
	if (!forward && !reopened) return []

	const tasks = new Set(units.map((unit) => unit.item.taskId))
	const single = units.length === 1 ? units[0]! : null
	const item: AttentionItemRef | null = single
		? single.item
		: tasks.size === 1 && first.unit.parent
			? {
					unit: null,
					kind: "task",
					taskId: first.unit.item.taskId,
					path: first.unit.parent.path,
					archived: units.every((unit) => unit.item.archived),
				}
			: null
	const subject: AttentionSubject = {
		workbase: first.workbase.ref,
		item,
		runtime: [],
		pullRequest: single?.pr ? { url: single.pr.url } : null,
		ticket: { url: ticket.url, key: ticket.key },
	}
	const evidenceItems = [
		...members.flatMap(({ unit }) => {
			const about = unitAbout(unit)
			return [
				...unitEvidence(unit, about),
				evidence(
					"pull_request",
					"state",
					unit.pr ? effectivePullRequestState(unit.pr) : "none",
					about,
				),
			]
		}),
		...ticketEvidence(ticket),
	]
	const label =
		item?.unit === null
			? item.taskId
			: single
				? unitLabel(single)
				: `${units.length} items`
	const transition = ticketTransition(
		ticket,
		forward ? "done" : "reopen",
		first.workbase.jira,
	)
	const preconditions: ActionPrecondition[] = forward
		? [
				{
					kind: "ticket_status_category",
					url: ticket.url,
					statusCategories: ["todo", "in_progress"],
				},
				...units.flatMap((unit) => [
					...unitPreconditions(unit, [unit.status]),
					...(unit.pr && mergedPr(unit)
						? [
								{
									kind: "pull_request_state",
									url: unit.pr.url,
									states: ["merged"],
								} as const,
							]
						: []),
				]),
			]
		: [
				{
					kind: "ticket_status_category",
					url: ticket.url,
					statusCategories: ["done"],
				},
				...active.flatMap((unit) => unitPreconditions(unit, ACTIVE)),
			]
	return [
		signal(
			"ticket_status_mismatch",
			ticket.url,
			forward
				? `${label} is delivered, but ${ticket.key} is ${ticket.status}`
				: `${ticket.key} is ${ticket.status}, but ${label} ${active.length === 1 && single ? "is" : "remain"} active with nothing done`,
			subject,
			evidenceItems,
			(id) => [
				...(transition
					? [
							makeAction(
								id,
								"command",
								{
									slug: "ticket-transition",
									title: transition.title,
									rationale: forward
										? "Every unit sharing the ticket is delivered; the ticket should reflect completion."
										: "No sharing unit is done; the ticket may have been closed early.",
									risk: "reversible",
									subject,
									preconditions,
								},
								{ argv: transition.argv, cwd: null },
							),
						]
					: []),
				openUrlAction(
					id,
					"open-ticket",
					`Open ${ticket.key}`,
					ticket.url,
					subject,
				),
			],
		),
	]
}

const ticketSignals = (snapshot: AttentionSnapshot): AttentionSignal[] => {
	const groups = new Map<
		string,
		{
			ticket: Extract<TicketRecord, { state: "available" }>
			members: Member[]
		}
	>()
	for (const workbase of snapshot.workbases) {
		for (const unit of workbase.units) {
			if (unit.ticket.state !== "available") continue
			const group = groups.get(unit.ticket.url) ?? {
				ticket: unit.ticket,
				members: [],
			}
			group.members.push({ workbase, unit })
			groups.set(unit.ticket.url, group)
		}
	}
	return [...groups.values()].flatMap((group) =>
		ticketStatusMismatch(group.ticket, group.members),
	)
}

const prMergedItemOpen = (
	workbase: AttentionWorkbase,
	unit: AttentionUnit,
): AttentionSignal[] => {
	if (!unit.pr || unit.item.archived || !ACTIVE.includes(unit.status)) return []
	if (effectivePullRequestState(unit.pr) !== "merged") return []
	const subject = subjectFor(workbase, unit)
	const pr = unit.pr
	return [
		signal(
			"pr_merged_item_open",
			unitScope(workbase, unit),
			`${unitLabel(unit)} has a merged PR but is still ${unit.status}`,
			subject,
			[...unitEvidence(unit), ...prEvidence(pr)],
			(id) =>
				agencyAction(
					id,
					workbase,
					unit.actions,
					"sync",
					{
						title: "Sync to record the merge",
						rationale:
							"Sync reconciles the merged pull request and marks the unit done.",
						risk: "reversible",
						subject,
						preconditions: [
							{ kind: "pull_request_state", url: pr.url, states: ["merged"] },
							...unitPreconditions(unit, ACTIVE),
						],
					},
					unit,
				),
		),
	]
}

const prReadyToMerge = (
	workbase: AttentionWorkbase,
	unit: AttentionUnit,
): AttentionSignal[] => {
	const pr = unit.pr
	if (!pr || unit.item.archived || !isReadyToMerge(pr.live)) return []
	const live = pr.live as Extract<LivePullRequest, { state: "available" }>
	const subject = subjectFor(workbase, unit)
	return [
		signal(
			"pr_ready_to_merge",
			unitScope(workbase, unit),
			`${unitLabel(unit)}'s PR is approved with green checks`,
			subject,
			[...unitEvidence(unit), ...prEvidence(pr)],
			(id) => [
				...(pr.mergeCommand && live.headSha
					? [
							makeAction(
								id,
								"command",
								{
									slug: "merge",
									title: "Merge the pull request",
									rationale:
										"The PR is approved, its checks passed, and it merges cleanly at the reviewed head.",
									risk: "destructive",
									subject,
									preconditions: [
										{
											kind: "pull_request_state",
											url: pr.url,
											states: ["open"],
										},
										{
											kind: "pull_request_head",
											url: pr.url,
											sha: live.headSha,
										},
									],
								},
								{ argv: pr.mergeCommand, cwd: null },
							),
						]
					: []),
				openUrlAction(id, "open-pr", "Open the pull request", pr.url, subject),
			],
		),
	]
}

/**
 * A working claim without a session is only unusual before review: a unit
 * stays working while its PR is open, and a merged PR is pr_merged_item_open.
 */
const claimWithoutSession = (
	snapshot: AttentionSnapshot,
	workbase: AttentionWorkbase,
	unit: AttentionUnit,
): AttentionSignal[] => {
	if (!snapshot.runtime.available) return []
	if (unit.item.archived || unit.status !== "working") return []
	if (unitPanes(unit).length > 0) return []
	const prState = unit.pr ? effectivePullRequestState(unit.pr) : null
	if (prState === "open" || prState === "merged") return []
	const subject = subjectFor(workbase, unit)
	const preconditions = [
		...unitPreconditions(unit, ["working"]),
		...(unit.pr
			? [
					{
						kind: "pull_request_state",
						url: unit.pr.url,
						states: ["closed"],
					} as const,
				]
			: []),
	]
	const offer = (
		id: string,
		actionId: string,
		title: string | undefined,
		rationale: string,
	) =>
		agencyAction(
			id,
			workbase,
			unit.actions,
			actionId,
			{ title, rationale, risk: "reversible", subject, preconditions },
			unit,
		)
	return [
		signal(
			"claim_without_session",
			unitScope(workbase, unit),
			`${unitLabel(unit)} is working but no live session hosts it`,
			subject,
			[
				...unitEvidence(unit),
				...prEvidence(unit.pr),
				evidence("runtime", "binding", unit.binding?.state ?? "none"),
				...(unit.binding
					? [evidence("runtime", "boundPaneId", unit.binding.record.paneId)]
					: []),
			],
			(id) => [
				...offer(
					id,
					"work",
					"Resume with a fresh agent",
					"Kick the claimed work off again in a new session.",
				),
				...(unit.review
					? offer(
							id,
							"finish-review",
							undefined,
							"Finish the review if it is complete.",
						)
					: offer(
							id,
							"drop",
							undefined,
							"Abandon the claim if the work is no longer wanted.",
						)),
				...offer(
					id,
					"archive",
					undefined,
					"Archive the work if it is already terminal.",
				),
			],
		),
	]
}

interface PaneOwner {
	readonly workbase: AttentionWorkbase
	readonly unit: AttentionUnit
	readonly entry: UnitPane
}

const paneOwners = (snapshot: AttentionSnapshot) => {
	const owners = new Map<string, PaneOwner>()
	for (const workbase of snapshot.workbases) {
		for (const unit of workbase.units) {
			for (const entry of unitPanes(unit)) {
				if (!owners.has(entry.pane.paneId))
					owners.set(entry.pane.paneId, { workbase, unit, entry })
			}
		}
	}
	return owners
}

const containsAny = (roots: readonly string[], path: string) =>
	roots.some((root) => contains(root, path))

/** The workbase whose root contains a pane, or "other" for an uninspected one. */
const paneWorkbase = (
	snapshot: AttentionSnapshot,
	pane: RuntimePane,
): AttentionWorkbase | "other" | null => {
	const cwd = paneCwd(pane)
	if (!cwd) return null
	const depth = (roots: readonly string[]) =>
		Math.max(
			-1,
			...roots.filter((root) => contains(root, cwd)).map((root) => root.length),
		)
	let best: { depth: number; workbase: AttentionWorkbase | "other" } | null =
		null
	for (const workbase of snapshot.workbases) {
		const found = depth(workbase.roots)
		if (found >= 0 && (!best || found > best.depth))
			best = { depth: found, workbase }
	}
	const other = depth(snapshot.otherRoots)
	if (other >= 0 && (!best || other > best.depth))
		best = { depth: other, workbase: "other" }
	return best?.workbase ?? null
}

const inspected = (owner: AttentionWorkbase | "other" | null) =>
	owner === "other" ? null : owner

/**
 * Agents at a workbase root or in epic or non-unit task directories are
 * orchestration sessions, not unmanaged ones.
 */
const isOrchestration = (workbase: AttentionWorkbase, pane: RuntimePane) => {
	const cwd = paneCwd(pane)
	if (!cwd) return false
	return workbase.roots.some(
		(root) =>
			relative(root, cwd) === "" ||
			["epics", "tasks"].some((directory) => {
				const parent = join(root, directory)
				return contains(parent, cwd) && relative(parent, cwd) !== ""
			}),
	)
}

const duplicateSessions = (
	snapshot: AttentionSnapshot,
	owners: ReadonlyMap<string, PaneOwner>,
): AttentionSignal[] => {
	const runtime = snapshot.runtime.provider
	if (!runtime) return []
	const bySession = new Map<string, RuntimePane[]>()
	for (const pane of snapshot.runtime.panes) {
		if (!pane.agentSessionId) continue
		bySession.set(pane.agentSessionId, [
			...(bySession.get(pane.agentSessionId) ?? []),
			pane,
		])
	}
	return [...bySession]
		.filter(([, panes]) => panes.length > 1)
		.map(([session, unsorted]) => {
			const panes = [...unsorted].sort((a, b) =>
				a.paneId.localeCompare(b.paneId),
			)
			const owner = panes.map((pane) => owners.get(pane.paneId)).find(Boolean)
			// Close duplicates only when a binding (or focus) says which to keep.
			const primary =
				panes.find(
					(pane) => pane.paneId === owner?.unit.binding?.record.paneId,
				) ??
				(panes.filter((pane) => pane.focused).length === 1
					? panes.find((pane) => pane.focused)!
					: null)
			const subject = subjectFor(
				owner?.workbase ?? inspected(paneWorkbase(snapshot, panes[0]!)),
				owner?.unit ?? null,
				panes.map((pane) => runtimeRef(runtime, pane)),
			)
			return signal(
				"duplicate_session",
				`${runtime}:${session}`,
				`Agent session ${session} is open in ${panes.length} panes`,
				subject,
				[
					evidence("runtime", "agentSessionId", session),
					evidence("runtime", "primaryPaneId", primary?.paneId ?? null),
					...panes.flatMap((pane) => paneEvidence(pane)),
				],
				(id) => [
					...panes.map((pane) => focusAction(id, runtime, pane, subject)),
					...(primary
						? panes
								.filter(
									(pane) =>
										pane !== primary && CLOSABLE.includes(pane.agentStatus),
								)
								.map((pane) =>
									closePaneAction(
										id,
										runtime,
										pane,
										subject,
										`Close duplicate pane ${pane.paneId}`,
										`Keep the session in ${primary.paneId}; a second pane on one session risks conflicting input.`,
										[paneMatches(runtime, primary, ANY_STATUS)],
									),
								)
						: []),
				],
			)
		})
}

/** Map a missing pane directory to the archived unit that used to live there. */
const archivedOwner = (
	snapshot: AttentionSnapshot,
	path: string,
): Omit<PaneOwner, "entry"> | null => {
	for (const workbase of snapshot.workbases) {
		for (const unit of workbase.units) {
			if (!unit.item.archived) continue
			const original = workbase.roots.map((root) =>
				unit.item.phaseId
					? join(root, "tasks", unit.item.taskId, "phases", unit.item.phaseId)
					: join(root, "tasks", unit.item.taskId),
			)
			if (containsAny(original, path)) return { workbase, unit }
		}
	}
	return null
}

const sessionCwdMissing = (
	snapshot: AttentionSnapshot,
	owners: ReadonlyMap<string, PaneOwner>,
	missing: ReadonlySet<string>,
	explained: ReadonlySet<string>,
): AttentionSignal[] => {
	const runtime = snapshot.runtime.provider
	if (!runtime) return []
	return snapshot.runtime.panes
		.filter((pane) => {
			const cwd = paneCwd(pane)
			return (
				pane.agent !== null &&
				cwd !== null &&
				missing.has(cwd) &&
				!explained.has(pane.paneId)
			)
		})
		.map((pane) => {
			const cwd = paneCwd(pane)!
			const bound = owners.get(pane.paneId)
			const owner = bound ?? archivedOwner(snapshot, cwd)
			const subject = subjectFor(
				owner?.workbase ?? inspected(paneWorkbase(snapshot, pane)),
				owner?.unit ?? null,
				[runtimeRef(runtime, pane)],
			)
			return signal(
				"session_cwd_missing",
				`${runtime}:${pane.paneId}`,
				`Pane ${pane.paneId} runs in a directory that no longer exists`,
				subject,
				[
					...paneEvidence(pane, bound?.entry),
					evidence("filesystem", "missingPath", cwd),
					...(owner ? unitEvidence(owner.unit, unitAbout(owner.unit)) : []),
				],
				(id) => [
					...closeActions(
						id,
						snapshot,
						[pane],
						subject,
						"The session's working directory is gone, so it cannot continue.",
						[{ kind: "path_exists", path: cwd, exists: false }],
					),
					focusAction(id, runtime, pane, subject),
				],
			)
		})
}

const agentWaiting = (
	snapshot: AttentionSnapshot,
	workbase: AttentionWorkbase,
	unit: AttentionUnit,
	missing: ReadonlySet<string>,
): AttentionSignal[] => {
	const runtime = snapshot.runtime.provider
	if (!runtime || unit.item.archived || TERMINAL.has(unit.status)) return []
	return unitPanes(unit)
		.filter(({ pane }) => {
			const cwd = paneCwd(pane)
			return WAITING.has(pane.agentStatus) && !(cwd && missing.has(cwd))
		})
		.map((entry) => {
			const pane = entry.pane
			const subject = subjectFor(workbase, unit, [runtimeRef(runtime, pane)])
			return signal(
				"agent_waiting",
				`${unitScope(workbase, unit)}:${pane.paneId}`,
				`The agent for ${unitLabel(unit)} is ${pane.agentStatus}`,
				subject,
				[...unitEvidence(unit), ...paneEvidence(pane, entry)],
				(id) => [focusAction(id, runtime, pane, subject)],
			)
		})
}

const unmanagedSessions = (
	snapshot: AttentionSnapshot,
	missing: ReadonlySet<string>,
): AttentionSignal[] => {
	const runtime = snapshot.runtime.provider
	if (!runtime) return []
	const claimed = new Set(
		snapshot.workbases.flatMap((workbase) => workbase.claimedPaneIds),
	)
	const defaultWorkbase =
		snapshot.workbases.find(
			(workbase) => workbase.isDefault && !workbase.error,
		) ?? null
	return snapshot.runtime.panes.flatMap((pane) => {
		const cwd = paneCwd(pane)
		if (pane.agent === null || claimed.has(pane.paneId)) return []
		if (cwd && missing.has(cwd)) return []
		const owner = paneWorkbase(snapshot, pane)
		// Panes inside another, uninspected workbase are not this run's concern.
		if (owner === "other") return []
		if (owner && isOrchestration(owner, pane)) return []
		const target = owner ? (owner.error ? null : owner) : defaultWorkbase
		const ref = runtimeRef(runtime, pane)
		const subject = subjectFor(target ?? owner, null, [ref])
		return [
			signal(
				"unmanaged_session",
				`${runtime}:${pane.paneId}`,
				`Pane ${pane.paneId} runs ${pane.agent} outside any Agency item`,
				subject,
				paneEvidence(pane),
				(id) => [
					...(target
						? agencyAction(
								id,
								target,
								target.actions,
								"task-create",
								{
									slug: "adopt",
									title: "Adopt this session as a new task",
									rationale:
										"Create a task for the session and bind it to this pane.",
									risk: "reversible",
									subject,
									preconditions: [paneMatches(runtime, pane, ANY_STATUS)],
								},
								null,
								ref,
							)
						: []),
					focusAction(id, runtime, pane, subject),
				],
			),
		]
	})
}

const signalOrder = (signal: AttentionSignal) =>
	SIGNAL_ORDER.indexOf(signal.kind)

/** Deterministic attention signals over one supervision snapshot. */
export const attentionSignals = (
	snapshot: AttentionSnapshot,
): AttentionSignal[] => {
	const missing = new Set(snapshot.missingPaths)
	const owners = paneOwners(snapshot)
	const signals: AttentionSignal[] = [...ticketSignals(snapshot)]
	for (const workbase of snapshot.workbases) {
		for (const unit of workbase.units) {
			signals.push(
				...completeSessionOpen(snapshot, workbase, unit),
				...prMergedItemOpen(workbase, unit),
				...prReadyToMerge(workbase, unit),
				...claimWithoutSession(snapshot, workbase, unit),
				...agentWaiting(snapshot, workbase, unit, missing),
			)
		}
	}
	// Completed work already explains its panes.
	const explained = new Set(
		signals
			.filter((signal) => signal.kind === "complete_session_open")
			.flatMap((signal) => signal.subject.runtime.map((ref) => ref.paneId)),
	)
	signals.push(
		...duplicateSessions(snapshot, owners),
		...sessionCwdMissing(snapshot, owners, missing, explained),
		...unmanagedSessions(snapshot, missing),
	)
	const workbaseRank = new Map(
		snapshot.workbases.map((workbase, index) => [workbase.ref.root, index]),
	)
	const rank = (signal: AttentionSignal) =>
		signal.subject.workbase
			? (workbaseRank.get(signal.subject.workbase.root) ?? 0)
			: snapshot.workbases.length
	return signals.sort(
		(a, b) =>
			rank(a) - rank(b) ||
			signalOrder(a) - signalOrder(b) ||
			a.id.localeCompare(b.id),
	)
}
