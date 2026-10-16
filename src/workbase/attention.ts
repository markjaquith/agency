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
import type { RuntimeKind, RuntimePane } from "./runtime"
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
	/** Why the workbase is supervised: registered, the current directory, or a live pane. */
	readonly source: "registered" | "current" | "runtime"
	readonly isDefault: boolean
	readonly error: string | null
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
const WAITING = new Set<RuntimePane["agentStatus"]>(["idle", "done", "blocked"])

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

export const isReadyToMerge = (live: LivePullRequest | null) =>
	live?.state === "available" &&
	live.prState === "open" &&
	!live.draft &&
	live.review === "approved" &&
	(live.checks === "passing" || live.checks === "none") &&
	live.mergeable !== "conflicting"

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

const workbaseKey = (ref: AttentionWorkbaseRef) => ref.id ?? ref.root

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

/** Panes that currently host a unit through its binding or an inference. */
const unitPanes = (unit: AttentionUnit): RuntimePane[] => {
	const panes = new Map<string, RuntimePane>()
	if (
		unit.binding &&
		unit.binding.state !== "gone" &&
		unit.binding.state !== "unknown"
	) {
		for (const pane of unit.binding.panes) panes.set(pane.paneId, pane)
	}
	for (const inferred of unit.inferred)
		panes.set(inferred.pane.paneId, inferred.pane)
	return [...panes.values()].sort((a, b) => a.paneId.localeCompare(b.paneId))
}

const evidence = (
	source: AttentionEvidence["source"],
	label: string,
	value: AttentionEvidence["value"],
): AttentionEvidence => ({ source, label, value })

const unitEvidence = (unit: AttentionUnit): AttentionEvidence[] => [
	evidence("agency", "status", unit.status),
	evidence("agency", "archived", unit.item.archived),
]

const prEvidence = (pr: AttentionPullRequest | null): AttentionEvidence[] => {
	if (!pr) return [evidence("pull_request", "state", "none")]
	const items = [
		evidence("pull_request", "url", pr.url),
		evidence("pull_request", "state", effectivePullRequestState(pr)),
		evidence(
			"pull_request",
			"source",
			pr.live?.state === "available" ? "live" : "recorded",
		),
	]
	if (pr.live?.state === "available") {
		items.push(
			evidence("pull_request", "draft", pr.live.draft),
			evidence("pull_request", "review", pr.live.review),
			evidence("pull_request", "checks", pr.live.checks),
			evidence("pull_request", "mergeable", pr.live.mergeable),
		)
	} else if (pr.live?.state === "unavailable") {
		items.push(evidence("pull_request", "liveError", pr.live.reason))
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

const paneEvidence = (pane: RuntimePane): AttentionEvidence[] => [
	evidence("runtime", "paneId", pane.paneId),
	evidence("runtime", "agent", pane.agent),
	evidence("runtime", "agentStatus", pane.agentStatus),
	evidence("runtime", "cwd", pane.foregroundCwd ?? pane.cwd),
]

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

const panePrecondition = (
	runtime: RuntimeKind,
	pane: RuntimePane,
): ActionPrecondition => ({
	kind: "pane_present",
	runtime,
	paneId: pane.paneId,
	present: true,
	agentSessionId: pane.agentSessionId,
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
	bindRuntime: AttentionRuntimeRef | null = null,
): SupervisorAction[] => {
	const entry = catalog.find((action) => action.id === actionId)
	if (!entry?.available) return []
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
				command: entry.command,
				commandTemplate: entry.commandTemplate,
				inputs: entry.inputs,
				cwd: workbase.ref.root,
				bindRuntime,
			},
		),
	]
}

const focusAction = (
	signalId: string,
	runtime: RuntimeKind,
	pane: RuntimePane,
	subject: AttentionSubject,
	slug = `focus-pane-${pane.paneId}`,
): SupervisorAction =>
	makeAction(
		signalId,
		"runtime",
		{
			slug,
			title: `Focus pane ${pane.paneId}`,
			rationale: "Look at the session before deciding what to do with it.",
			risk: "reversible",
			subject,
			preconditions: [panePrecondition(runtime, pane)],
		},
		{ runtime, operation: "focus", target: "pane", id: pane.paneId },
	)

/**
 * Close whole tabs when every agent pane in them belongs to the subject (the
 * remaining panes, such as an editor, belong with it); otherwise close panes.
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
	const ids = new Set(panes.map((pane) => pane.paneId))
	const tabs = [...new Set(panes.map((pane) => pane.tabId))].sort()
	return tabs.flatMap((tabId) => {
		const inTab = panes.filter((pane) => pane.tabId === tabId)
		const preconditions = [
			...extraPreconditions,
			...inTab.map((pane) => panePrecondition(runtime, pane)),
		]
		const whole = snapshot.runtime.panes
			.filter((pane) => pane.tabId === tabId && pane.agent !== null)
			.every((pane) => ids.has(pane.paneId))
		if (whole) {
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
						preconditions,
					},
					{ runtime, operation: "close", target: "tab", id: tabId },
				),
			]
		}
		return inTab.map((pane) =>
			makeAction(
				signalId,
				"runtime",
				{
					slug: `close-pane-${pane.paneId}`,
					title: `Close pane ${pane.paneId}`,
					rationale,
					risk: "destructive",
					subject,
					preconditions: [
						...extraPreconditions,
						panePrecondition(runtime, pane),
					],
				},
				{ runtime, operation: "close", target: "pane", id: pane.paneId },
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
	target: "done" | "not_planned" | "reopen",
): { readonly argv: readonly string[]; readonly title: string } | null => {
	if (ticket.provider === "jira") {
		const status = target === "reopen" ? "In Progress" : "Done"
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
		if (target === "reopen")
			return {
				argv: ["gh", "issue", "reopen", ticket.url],
				title: `Reopen ${ticket.key}`,
			}
		return {
			argv: [
				"gh",
				"issue",
				"close",
				ticket.url,
				"--reason",
				target === "done" ? "completed" : "not planned",
			],
			title:
				target === "done"
					? `Close ${ticket.key} as completed`
					: `Close ${ticket.key} as not planned`,
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
	`${workbaseKey(workbase.ref)}:${unit.item.unit}`

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
	const panes = unitPanes(unit)
	if (!runtime || panes.length === 0) return []
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
	const refs = panes.map((pane) => runtimeRef(runtime, pane))
	const subject = subjectFor(workbase, unit, refs)
	const state = unit.item.archived ? "archived" : unit.status
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
				...panes.flatMap(paneEvidence),
			],
			(id) => [
				...closeActions(
					id,
					snapshot,
					panes,
					subject,
					"The work is complete; its session no longer needs supervision.",
					unit.item.archived
						? [
								{
									kind: "item_archived",
									unit: unit.item.unit,
									archived: true,
								},
							]
						: unitPreconditions(unit, ["done", "dropped"]),
				),
				focusAction(id, runtime, panes[0]!, subject),
				...(unit.item.archived
					? []
					: agencyAction(id, workbase, unit.actions, "archive", {
							rationale:
								"Terminal work can move to the archive once its session closes.",
							risk: "reversible",
							subject,
							preconditions: unitPreconditions(unit, ["done", "dropped"]),
						})),
			],
		),
	]
}

const ticketStatusMismatch = (
	workbase: AttentionWorkbase,
	unit: AttentionUnit,
): AttentionSignal[] => {
	const ticket = unit.ticket
	if (ticket.state !== "available") return []
	const subject = subjectFor(workbase, unit)
	const prState = unit.pr ? effectivePullRequestState(unit.pr) : null
	const evidenceItems = [
		...unitEvidence(unit),
		...prEvidence(unit.pr),
		...ticketEvidence(ticket),
	]
	const scope = unitScope(workbase, unit)
	if (
		unit.status === "done" &&
		prState === "merged" &&
		ticket.statusCategory !== "done"
	) {
		const transition = ticketTransition(ticket, "done")
		return [
			signal(
				"ticket_status_mismatch",
				scope,
				`${unitLabel(unit)} is done with a merged PR, but ${ticket.key} is ${ticket.status}`,
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
										rationale:
											"The delivered work is merged; the ticket should reflect completion.",
										risk: "reversible",
										subject,
										preconditions: [
											{
												kind: "ticket_status_category",
												url: ticket.url,
												statusCategories: ["todo", "in_progress"],
											},
										],
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
	if (
		ticket.statusCategory === "done" &&
		!unit.item.archived &&
		ACTIVE.includes(unit.status)
	) {
		const transition = ticketTransition(ticket, "reopen")
		return [
			signal(
				"ticket_status_mismatch",
				scope,
				`${ticket.key} is ${ticket.status}, but ${unitLabel(unit)} is still ${unit.status}`,
				subject,
				evidenceItems,
				(id) => [
					openUrlAction(
						id,
						"open-ticket",
						`Open ${ticket.key}`,
						ticket.url,
						subject,
					),
					...(transition
						? [
								makeAction(
									id,
									"command",
									{
										slug: "ticket-transition",
										title: transition.title,
										rationale:
											"The work item is still active; the ticket may have been closed early.",
										risk: "reversible",
										subject,
										preconditions: [
											{
												kind: "ticket_status_category",
												url: ticket.url,
												statusCategories: ["done"],
											},
											...unitPreconditions(unit, ACTIVE),
										],
									},
									{ argv: transition.argv, cwd: null },
								),
							]
						: []),
				],
			),
		]
	}
	return []
}

/** A multi-phase task's ticket reflects every phase, so compare it once. */
const phasedTicketStatusMismatch = (
	workbase: AttentionWorkbase,
	phases: readonly AttentionUnit[],
): AttentionSignal[] => {
	const first = phases[0]!
	const ticket = first.ticket
	if (ticket.state !== "available" || !first.parent) return []
	const archived = phases.every((phase) => phase.item.archived)
	const subject: AttentionSubject = {
		...subjectFor(workbase, first),
		item: {
			unit: null,
			kind: "task",
			taskId: first.item.taskId,
			path: first.parent.path,
			archived,
		},
		pullRequest: null,
	}
	const evidenceItems = [
		...phases.flatMap((phase) => [
			evidence("agency", `${phase.item.phaseId} status`, phase.status),
			evidence(
				"pull_request",
				`${phase.item.phaseId} state`,
				phase.pr ? effectivePullRequestState(phase.pr) : "none",
			),
		]),
		...ticketEvidence(ticket),
	]
	const scope = `${workbaseKey(workbase.ref)}:task:${first.item.taskId}`
	const taskRevision: ActionPrecondition[] = first.parent.revision
		? [
				{
					kind: "document_revision",
					path: first.parent.path,
					sha256: first.parent.revision,
				},
			]
		: []
	const phaseStatuses = (statuses: readonly WorkStatus[]) =>
		phases
			.filter((phase) => !phase.item.archived)
			.map(
				(phase): ActionPrecondition => ({
					kind: "item_status",
					unit: phase.item.unit,
					statuses,
				}),
			)
	const delivered =
		phases.every((phase) => TERMINAL.has(phase.status)) &&
		phases.some(
			(phase) =>
				phase.status === "done" &&
				phase.pr !== null &&
				effectivePullRequestState(phase.pr) === "merged",
		) &&
		phases.every(
			(phase) =>
				phase.status !== "done" ||
				phase.pr === null ||
				effectivePullRequestState(phase.pr) === "merged",
		)
	const active = phases.filter(
		(phase) => !phase.item.archived && ACTIVE.includes(phase.status),
	)
	const transitionAction = (
		id: string,
		target: "done" | "reopen",
		rationale: string,
		preconditions: readonly ActionPrecondition[],
	) => {
		const transition = ticketTransition(ticket, target)
		return transition
			? [
					makeAction(
						id,
						"command",
						{
							slug: "ticket-transition",
							title: transition.title,
							rationale,
							risk: "reversible",
							subject,
							preconditions,
						},
						{ argv: transition.argv, cwd: null },
					),
				]
			: []
	}
	if (delivered && ticket.statusCategory !== "done") {
		return [
			signal(
				"ticket_status_mismatch",
				scope,
				`Every phase of ${first.item.taskId} is complete, but ${ticket.key} is ${ticket.status}`,
				subject,
				evidenceItems,
				(id) => [
					...transitionAction(
						id,
						"done",
						"Every phase is delivered; the ticket should reflect completion.",
						[
							{
								kind: "ticket_status_category",
								url: ticket.url,
								statusCategories: ["todo", "in_progress"],
							},
							...phaseStatuses(["done", "dropped"]),
						],
					),
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
	if (ticket.statusCategory === "done" && active.length > 0) {
		return [
			signal(
				"ticket_status_mismatch",
				scope,
				`${ticket.key} is ${ticket.status}, but ${active.length} phase${active.length === 1 ? "" : "s"} of ${first.item.taskId} remain active`,
				subject,
				evidenceItems,
				(id) => [
					openUrlAction(
						id,
						"open-ticket",
						`Open ${ticket.key}`,
						ticket.url,
						subject,
					),
					...transitionAction(
						id,
						"reopen",
						"Phases are still active; the ticket may have been closed early.",
						[
							{
								kind: "ticket_status_category",
								url: ticket.url,
								statusCategories: ["done"],
							},
							...taskRevision,
						],
					),
				],
			),
		]
	}
	return []
}

const ticketSignals = (workbase: AttentionWorkbase): AttentionSignal[] => {
	const phased = new Map<string, AttentionUnit[]>()
	const signals: AttentionSignal[] = []
	for (const unit of workbase.units) {
		if (!unit.item.phaseId) {
			signals.push(...ticketStatusMismatch(workbase, unit))
			continue
		}
		phased.set(unit.item.taskId, [
			...(phased.get(unit.item.taskId) ?? []),
			unit,
		])
	}
	for (const phases of phased.values())
		signals.push(...phasedTicketStatusMismatch(workbase, phases))
	return signals
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
				agencyAction(id, workbase, unit.actions, "sync", {
					title: "Sync to record the merge",
					rationale:
						"Sync reconciles the merged pull request and marks the unit done.",
					risk: "reversible",
					subject,
					preconditions: [
						{ kind: "pull_request_state", url: pr.url, states: ["merged"] },
						...unitPreconditions(unit, ACTIVE),
					],
				}),
		),
	]
}

const prReadyToMerge = (
	workbase: AttentionWorkbase,
	unit: AttentionUnit,
): AttentionSignal[] => {
	const pr = unit.pr
	if (!pr || unit.item.archived || !isReadyToMerge(pr.live)) return []
	const subject = subjectFor(workbase, unit)
	return [
		signal(
			"pr_ready_to_merge",
			unitScope(workbase, unit),
			`${unitLabel(unit)}'s PR is approved with green checks`,
			subject,
			[...unitEvidence(unit), ...prEvidence(pr)],
			(id) => [
				...(pr.mergeCommand
					? [
							makeAction(
								id,
								"command",
								{
									slug: "merge",
									title: "Merge the pull request",
									rationale: "The PR is approved and its checks are green.",
									risk: "destructive",
									subject,
									preconditions: [
										{
											kind: "pull_request_state",
											url: pr.url,
											states: ["open"],
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

const claimWithoutSession = (
	snapshot: AttentionSnapshot,
	workbase: AttentionWorkbase,
	unit: AttentionUnit,
): AttentionSignal[] => {
	if (!snapshot.runtime.available) return []
	if (unit.item.archived || unit.status !== "working") return []
	if (unitPanes(unit).length > 0) return []
	const subject = subjectFor(workbase, unit)
	const preconditions = unitPreconditions(unit, ["working"])
	return [
		signal(
			"claim_without_session",
			unitScope(workbase, unit),
			`${unitLabel(unit)} is working but no live session hosts it`,
			subject,
			[
				...unitEvidence(unit),
				evidence("runtime", "binding", unit.binding?.state ?? "none"),
				...(unit.binding
					? [evidence("runtime", "boundPaneId", unit.binding.record.paneId)]
					: []),
			],
			(id) => [
				...agencyAction(id, workbase, unit.actions, "work", {
					title: "Resume with a fresh agent",
					rationale: "Kick the claimed work off again in a new session.",
					risk: "reversible",
					subject,
					preconditions,
				}),
				...agencyAction(id, workbase, unit.actions, "drop", {
					rationale: "Abandon the claim if the work is no longer wanted.",
					risk: "reversible",
					subject,
					preconditions,
				}),
				...agencyAction(id, workbase, unit.actions, "archive", {
					rationale: "Archive the work if it is already terminal.",
					risk: "reversible",
					subject,
					preconditions,
				}),
			],
		),
	]
}

interface PaneOwner {
	readonly workbase: AttentionWorkbase
	readonly unit: AttentionUnit
}

const paneOwners = (snapshot: AttentionSnapshot) => {
	const owners = new Map<string, PaneOwner>()
	for (const workbase of snapshot.workbases) {
		for (const unit of workbase.units) {
			for (const pane of unitPanes(unit)) {
				if (!owners.has(pane.paneId))
					owners.set(pane.paneId, { workbase, unit })
			}
		}
	}
	return owners
}

const paneCwd = (pane: RuntimePane) => pane.foregroundCwd ?? pane.cwd

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
			const primary =
				panes.find(
					(pane) => pane.paneId === owner?.unit.binding?.record.paneId,
				) ?? panes[0]!
			const subject = subjectFor(
				owner?.workbase ?? containingWorkbase(snapshot, primary),
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
					evidence("runtime", "primaryPaneId", primary.paneId),
					...panes.flatMap(paneEvidence),
				],
				(id) => [
					...panes.map((pane) => focusAction(id, runtime, pane, subject)),
					...panes
						.filter((pane) => pane !== primary)
						.map((pane) =>
							makeAction(
								id,
								"runtime",
								{
									slug: `close-pane-${pane.paneId}`,
									title: `Close duplicate pane ${pane.paneId}`,
									rationale: `Keep the session in ${primary.paneId}; a second pane on one session risks conflicting input.`,
									risk: "destructive",
									subject,
									preconditions: [
										panePrecondition(runtime, pane),
										panePrecondition(runtime, primary),
									],
								},
								{
									runtime,
									operation: "close",
									target: "pane",
									id: pane.paneId,
								},
							),
						),
				],
			)
		})
}

/** Map a missing pane directory to the archived unit that used to live there. */
const archivedOwner = (
	snapshot: AttentionSnapshot,
	path: string,
): PaneOwner | null => {
	for (const workbase of snapshot.workbases) {
		for (const unit of workbase.units) {
			if (!unit.item.archived) continue
			const original = unit.item.phaseId
				? join(
						workbase.ref.root,
						"tasks",
						unit.item.taskId,
						"phases",
						unit.item.phaseId,
					)
				: join(workbase.ref.root, "tasks", unit.item.taskId)
			if (contains(original, path)) return { workbase, unit }
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
			const owner = owners.get(pane.paneId) ?? archivedOwner(snapshot, cwd)
			const subject = subjectFor(
				owner?.workbase ?? containingWorkbase(snapshot, pane),
				owner?.unit ?? null,
				[runtimeRef(runtime, pane)],
			)
			return signal(
				"session_cwd_missing",
				`${runtime}:${pane.paneId}`,
				`Pane ${pane.paneId} runs in a directory that no longer exists`,
				subject,
				[
					...paneEvidence(pane),
					evidence("filesystem", "missingPath", cwd),
					...(owner ? unitEvidence(owner.unit) : []),
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
		.filter((pane) => {
			const cwd = paneCwd(pane)
			return WAITING.has(pane.agentStatus) && !(cwd && missing.has(cwd))
		})
		.map((pane) => {
			const subject = subjectFor(workbase, unit, [runtimeRef(runtime, pane)])
			return signal(
				"agent_waiting",
				`${unitScope(workbase, unit)}:${pane.paneId}`,
				`The agent for ${unitLabel(unit)} is ${pane.agentStatus}`,
				subject,
				[...unitEvidence(unit), ...paneEvidence(pane)],
				(id) => [focusAction(id, runtime, pane, subject)],
			)
		})
}

const containingWorkbase = (
	snapshot: AttentionSnapshot,
	pane: RuntimePane,
): AttentionWorkbase | null => {
	const cwd = paneCwd(pane)
	if (!cwd) return null
	return (
		snapshot.workbases
			.filter((workbase) => contains(workbase.ref.root, cwd))
			.sort((a, b) => b.ref.root.length - a.ref.root.length)[0] ?? null
	)
}

/** Agents in epic or multi-phase task directories are orchestration sessions. */
const isOrchestration = (
	workbase: AttentionWorkbase | null,
	pane: RuntimePane,
) => {
	const cwd = paneCwd(pane)
	return (
		workbase !== null &&
		cwd !== null &&
		["epics", "tasks"].some((directory) => {
			const parent = join(workbase.ref.root, directory)
			return contains(parent, cwd) && relative(parent, cwd) !== ""
		})
	)
}

const adoptionWorkbase = (
	snapshot: AttentionSnapshot,
	pane: RuntimePane,
): AttentionWorkbase | null => {
	const containing = containingWorkbase(snapshot, pane)
	if (containing) return containing.error ? null : containing
	return (
		snapshot.workbases.find(
			(workbase) => workbase.isDefault && !workbase.error,
		) ?? null
	)
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
	return snapshot.runtime.panes
		.filter((pane) => {
			const cwd = paneCwd(pane)
			return (
				pane.agent !== null &&
				!claimed.has(pane.paneId) &&
				!(cwd && missing.has(cwd)) &&
				!isOrchestration(containingWorkbase(snapshot, pane), pane)
			)
		})
		.map((pane) => {
			const ref = runtimeRef(runtime, pane)
			const workbase = adoptionWorkbase(snapshot, pane)
			const subject = subjectFor(
				workbase ?? containingWorkbase(snapshot, pane),
				null,
				[ref],
			)
			return signal(
				"unmanaged_session",
				`${runtime}:${pane.paneId}`,
				`Pane ${pane.paneId} runs ${pane.agent} outside any Agency item`,
				subject,
				paneEvidence(pane),
				(id) => [
					...(workbase
						? agencyAction(
								id,
								workbase,
								workbase.actions,
								"task-create",
								{
									slug: "adopt",
									title: "Adopt this session as a new task",
									rationale:
										"Create a task for the session and bind it to this pane.",
									risk: "reversible",
									subject,
									preconditions: [panePrecondition(runtime, pane)],
								},
								ref,
							)
						: []),
					focusAction(id, runtime, pane, subject),
				],
			)
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
	const signals: AttentionSignal[] = []
	for (const workbase of snapshot.workbases) {
		signals.push(...ticketSignals(workbase))
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
	// Completed work already explains (and closes) its panes.
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
