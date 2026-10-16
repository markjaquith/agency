import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { AttentionSignal } from "../attention-schema"
import type { LivePullRequest } from "../services/PullRequestStatusService"
import { runtimePane } from "../test-utils"
import type { TicketRecord } from "../tickets/provider"
import {
	attentionSignals,
	type AttentionSnapshot,
	type AttentionUnit,
	type AttentionWorkbase,
	type CatalogAction,
} from "./attention"
import type { RuntimePane } from "./runtime"

const root = "/work"

const catalogAction = (
	id: string,
	command: readonly string[],
	available = true,
): CatalogAction => ({
	id,
	label: id[0]!.toUpperCase() + id.slice(1),
	available,
	blockedReason: available ? null : "Blocked",
	command,
	commandTemplate: null,
	inputs: [],
})

const unitActions = (taskId: string) => [
	catalogAction("work", ["agency", "work", "--task", taskId, "--auto"]),
	catalogAction("drop", ["agency", "task", "status", taskId, "dropped"]),
	catalogAction("sync", ["agency", "sync", taskId]),
	catalogAction("archive", ["agency", "archive", "task", taskId], false),
]

const ticket = (
	statusCategory: "todo" | "in_progress" | "done",
	provider = "jira",
): TicketRecord => ({
	url: "https://example.atlassian.net/browse/CAN-1",
	state: "available",
	provider,
	key: "CAN-1",
	status:
		statusCategory === "done"
			? "Done"
			: statusCategory === "todo"
				? "Backlog"
				: "In Progress",
	statusCategory,
	summary: "Ticket",
	resolution: null,
})

const livePr = (fields: Partial<LivePullRequest> = {}): LivePullRequest =>
	({
		state: "available",
		url: "https://github.com/acme/app/pull/1",
		prState: "open",
		draft: false,
		review: "none",
		checks: "pending",
		mergeable: "mergeable",
		...fields,
	}) as LivePullRequest

const unit = (
	taskId: string,
	fields: Partial<Omit<AttentionUnit, "item">> & {
		readonly archived?: boolean
		readonly phaseId?: string
		readonly prState?: "open" | "closed" | "merged"
		readonly live?: LivePullRequest | null
		readonly panes?: readonly RuntimePane[]
	} = {},
): AttentionUnit => {
	const {
		archived = false,
		phaseId,
		prState,
		live = null,
		panes,
		...rest
	} = fields
	const id = phaseId
		? `execution-unit:phase/${taskId}/${phaseId}`
		: `execution-unit:task/${taskId}`
	return {
		item: {
			unit: id,
			kind: phaseId ? "phase" : "task",
			taskId,
			...(phaseId ? { phaseId } : {}),
			path: phaseId
				? `${root}/tasks/${taskId}/phases/${phaseId}/PHASE.md`
				: `${root}/tasks/${taskId}/TASK.md`,
			archived,
		},
		parent: phaseId
			? { path: `${root}/tasks/${taskId}/TASK.md`, revision: "t".repeat(64) }
			: null,
		status: "working",
		revision: archived ? null : "a".repeat(64),
		pr: prState
			? {
					url: "https://github.com/acme/app/pull/1",
					repository: "acme/app",
					recordedState: prState,
					live,
					mergeCommand: null,
				}
			: null,
		ticket: { url: null, state: "none" },
		binding: panes
			? {
					record: {
						version: 1,
						workbase: root,
						unit: id,
						runtime: "herdr",
						paneId: panes[0]!.paneId,
						tabId: panes[0]!.tabId,
						workspaceId: panes[0]!.workspaceId,
						agent: "opencode",
						agentSessionId: panes[0]!.agentSessionId,
						agencySessionId: null,
						boundAt: "2026-10-16T00:00:00.000Z",
					},
					state: "live",
					panes,
				}
			: null,
		inferred: [],
		actions: unitActions(taskId),
		...rest,
	}
}

const workbase = (
	units: readonly AttentionUnit[],
	fields: Partial<AttentionWorkbase> = {},
): AttentionWorkbase => ({
	ref: { id: "wb-1", name: "main", root },
	source: "registered",
	isDefault: true,
	error: null,
	units,
	actions: [
		{
			...catalogAction("task-create", []),
			command: null,
			commandTemplate: ["agency", "task", "create", "<id>"],
			inputs: [{ id: "id", label: "Task ID", required: true }],
		},
	],
	claimedPaneIds: units.flatMap((item) =>
		(item.binding?.panes ?? []).map((pane) => pane.paneId),
	),
	...fields,
})

const snapshot = (
	workbases: readonly AttentionWorkbase[],
	panes: readonly RuntimePane[] = [],
	fields: Partial<AttentionSnapshot> = {},
): AttentionSnapshot => ({
	runtime: { provider: "herdr", available: true, error: null, panes },
	workbases,
	missingPaths: [],
	...fields,
})

const kinds = (current: AttentionSnapshot) =>
	attentionSignals(current).map((signal) => signal.kind)

const only = (current: AttentionSnapshot, kind: string) => {
	const matches = attentionSignals(current).filter(
		(signal) => signal.kind === kind,
	)
	expect(matches).toHaveLength(1)
	return matches[0]!
}

describe("attention signals", () => {
	test("emit valid, deterministic signals", () => {
		const pane = runtimePane({
			paneId: "w1:p1",
			agentSessionId: "ses_1",
			cwd: `${root}/tasks/alpha`,
		})
		const current = snapshot(
			[
				workbase([
					unit("alpha", { status: "done", prState: "merged", panes: [pane] }),
					unit("beta"),
				]),
			],
			[pane],
		)
		const first = attentionSignals(current)
		expect(first).toEqual(attentionSignals(current))
		for (const signal of first) {
			expect(() =>
				Schema.decodeUnknownSync(AttentionSignal)(signal),
			).not.toThrow()
		}
	})

	test("complete_session_open closes the tab of terminal settled work", () => {
		const worker = runtimePane({
			paneId: "w1:p1",
			agentSessionId: "ses_1",
			cwd: `${root}/tasks/alpha`,
		})
		const editor = runtimePane({ paneId: "w1:p2", agent: null })
		const signal = only(
			snapshot(
				[
					workbase([
						unit("alpha", {
							status: "done",
							prState: "merged",
							ticket: ticket("done"),
							panes: [worker],
						}),
					]),
				],
				[worker, editor],
			),
			"complete_session_open",
		)
		expect(signal.subject.item?.taskId).toBe("alpha")
		expect(signal.subject.runtime.map((ref) => ref.paneId)).toEqual(["w1:p1"])
		const close = signal.actions.find((action) => action.type === "runtime")!
		expect(close).toMatchObject({
			risk: "destructive",
			payload: { operation: "close", target: "tab", id: "w1:t1" },
		})
		expect(close.preconditions).toContainEqual({
			kind: "pane_present",
			runtime: "herdr",
			paneId: "w1:p1",
			present: true,
			agentSessionId: "ses_1",
		})
	})

	test("complete_session_open closes only the pane when the tab hosts other agents", () => {
		const worker = runtimePane({ paneId: "w1:p1", agentSessionId: "ses_1" })
		const other = runtimePane({ paneId: "w1:p2", agentSessionId: "ses_2" })
		const signal = only(
			snapshot(
				[workbase([unit("alpha", { status: "dropped", panes: [worker] })])],
				[worker, other],
			),
			"complete_session_open",
		)
		expect(signal.actions[0]).toMatchObject({
			payload: { operation: "close", target: "pane", id: "w1:p1" },
		})
	})

	test("complete_session_open waits for an open PR or unfinished ticket", () => {
		const pane = runtimePane({ paneId: "w1:p1", agentSessionId: "ses_1" })
		const withPr = snapshot(
			[
				workbase([
					unit("alpha", { status: "done", prState: "open", panes: [pane] }),
				]),
			],
			[pane],
		)
		const withTicket = snapshot(
			[
				workbase([
					unit("alpha", {
						status: "done",
						ticket: ticket("in_progress"),
						panes: [pane],
					}),
				]),
			],
			[pane],
		)
		expect(kinds(withPr)).not.toContain("complete_session_open")
		expect(kinds(withTicket)).not.toContain("complete_session_open")
	})

	test("complete_session_open covers archived work", () => {
		const pane = runtimePane({ paneId: "w1:p1", agentSessionId: "ses_1" })
		const signal = only(
			snapshot(
				[
					workbase([
						unit("alpha", {
							archived: true,
							status: "done",
							prState: "merged",
							panes: [pane],
						}),
					]),
				],
				[pane],
			),
			"complete_session_open",
		)
		expect(signal.title).toContain("archived")
		expect(signal.actions.some((action) => action.type === "agency")).toBe(
			false,
		)
	})

	test("ticket_status_mismatch suggests an explicit ticket transition", () => {
		const signal = only(
			snapshot([
				workbase([
					unit("alpha", {
						status: "done",
						prState: "merged",
						ticket: ticket("in_progress"),
					}),
				]),
			]),
			"ticket_status_mismatch",
		)
		const transition = signal.actions.find(
			(action) => action.type === "command",
		)!
		expect(transition).toMatchObject({
			risk: "reversible",
			payload: {
				argv: [
					"acli",
					"jira",
					"workitem",
					"transition",
					"--key",
					"CAN-1",
					"--status",
					"Done",
					"--yes",
				],
			},
		})
	})

	test("ticket_status_mismatch flags a done ticket on active work", () => {
		const signal = only(
			snapshot([
				workbase([
					unit("alpha", {
						status: "open",
						ticket: ticket("done", "github"),
					}),
				]),
			]),
			"ticket_status_mismatch",
		)
		expect(
			signal.actions.find((action) => action.type === "command")?.payload,
		).toMatchObject({
			argv: [
				"gh",
				"issue",
				"reopen",
				"https://example.atlassian.net/browse/CAN-1",
			],
		})
	})

	test("ticket_status_mismatch evaluates a multi-phase task once", () => {
		const shared = ticket("in_progress")
		const partial = snapshot([
			workbase([
				unit("multi", {
					phaseId: "one",
					status: "done",
					prState: "merged",
					ticket: shared,
				}),
				unit("multi", { phaseId: "two", status: "working", ticket: shared }),
			]),
		])
		expect(kinds(partial)).not.toContain("ticket_status_mismatch")
		const complete = only(
			snapshot([
				workbase([
					unit("multi", {
						phaseId: "one",
						status: "done",
						prState: "merged",
						ticket: shared,
					}),
					unit("multi", {
						phaseId: "two",
						status: "done",
						prState: "merged",
						ticket: shared,
					}),
				]),
			]),
			"ticket_status_mismatch",
		)
		expect(complete.subject.item).toMatchObject({
			unit: null,
			kind: "task",
			taskId: "multi",
		})
	})

	test("pr_merged_item_open uses the live PR state and suggests sync", () => {
		const signal = only(
			snapshot([
				workbase([
					unit("alpha", {
						prState: "open",
						live: livePr({ prState: "merged" }),
						panes: [runtimePane({ paneId: "w1:p1", agentStatus: "working" })],
					}),
				]),
			]),
			"pr_merged_item_open",
		)
		expect(signal.actions).toHaveLength(1)
		expect(signal.actions[0]).toMatchObject({
			type: "agency",
			payload: {
				actionId: "sync",
				command: ["agency", "sync", "alpha"],
				cwd: root,
			},
		})
	})

	test("pr_ready_to_merge requires approval, green checks, and no conflicts", () => {
		const ready = livePr({ review: "approved", checks: "passing" })
		const make = (live: LivePullRequest) =>
			snapshot([
				workbase([
					{
						...unit("alpha", { prState: "open", live }),
						pr: {
							url: "https://github.com/acme/app/pull/1",
							repository: "acme/app",
							recordedState: "open",
							live,
							mergeCommand: [
								"gh",
								"pr",
								"merge",
								"https://github.com/acme/app/pull/1",
								"--squash",
							],
						},
					},
				]),
			])
		expect(kinds(make(livePr({ review: "approved" })))).not.toContain(
			"pr_ready_to_merge",
		)
		expect(
			kinds(
				make(livePr({ review: "approved", checks: "passing", draft: true })),
			),
		).not.toContain("pr_ready_to_merge")
		expect(
			kinds(
				make(
					livePr({
						review: "approved",
						checks: "passing",
						mergeable: "conflicting",
					}),
				),
			),
		).not.toContain("pr_ready_to_merge")
		const signal = only(make(ready), "pr_ready_to_merge")
		expect(signal.actions[0]).toMatchObject({
			type: "command",
			risk: "destructive",
			payload: {
				argv: [
					"gh",
					"pr",
					"merge",
					"https://github.com/acme/app/pull/1",
					"--squash",
				],
			},
		})
	})

	test("claim_without_session offers only available act actions", () => {
		const signal = only(
			snapshot([workbase([unit("alpha")])]),
			"claim_without_session",
		)
		expect(
			signal.actions.map((action) =>
				action.type === "agency" ? action.payload.actionId : action.type,
			),
		).toEqual(["work", "drop"])
		expect(signal.actions[0]!.preconditions).toContainEqual({
			kind: "item_status",
			unit: "execution-unit:task/alpha",
			statuses: ["working"],
		})
	})

	test("claim_without_session needs a live runtime", () => {
		const current = snapshot([workbase([unit("alpha")])], [], {
			runtime: { provider: null, available: false, error: null, panes: [] },
		})
		expect(kinds(current)).toEqual([])
	})

	test("duplicate_session keeps the bound pane and closes the other", () => {
		const bound = runtimePane({
			paneId: "w1:p2",
			tabId: "w1:t2",
			agentSessionId: "ses_1",
			agentStatus: "working",
		})
		const copy = runtimePane({
			paneId: "w1:p1",
			agentSessionId: "ses_1",
			agentStatus: "working",
		})
		const signal = only(
			snapshot(
				[
					workbase([
						{
							...unit("alpha", { panes: [bound] }),
							binding: {
								...unit("alpha", { panes: [bound] }).binding!,
								state: "duplicated",
								panes: [copy, bound],
							},
						},
					]),
				],
				[copy, bound],
			),
			"duplicate_session",
		)
		expect(signal.subject.item?.taskId).toBe("alpha")
		const closes = signal.actions.filter(
			(action) =>
				action.type === "runtime" && action.payload.operation === "close",
		)
		expect(closes.map((action) => action.payload)).toEqual([
			{ runtime: "herdr", operation: "close", target: "pane", id: "w1:p1" },
		])
	})

	test("session_cwd_missing maps a removed directory to its archived item", () => {
		const pane = runtimePane({
			paneId: "w1:p3",
			agentSessionId: "ses_3",
			cwd: `${root}/tasks/gone/code/app`,
		})
		const current = snapshot(
			[workbase([unit("gone", { archived: true, status: "done" })])],
			[pane],
			{ missingPaths: [`${root}/tasks/gone/code/app`] },
		)
		const signal = only(current, "session_cwd_missing")
		expect(signal.subject.item).toMatchObject({
			taskId: "gone",
			archived: true,
		})
		expect(signal.actions[0]!.preconditions).toContainEqual({
			kind: "path_exists",
			path: `${root}/tasks/gone/code/app`,
			exists: false,
		})
		expect(kinds(current)).not.toContain("unmanaged_session")
	})

	test("agent_waiting reports idle, done, and blocked bound agents", () => {
		const idle = runtimePane({ paneId: "w1:p1", agentStatus: "blocked" })
		const signal = only(
			snapshot([workbase([unit("alpha", { panes: [idle] })])], [idle]),
			"agent_waiting",
		)
		expect(signal.title).toContain("blocked")
		const working = runtimePane({ paneId: "w1:p1", agentStatus: "working" })
		expect(
			kinds(
				snapshot([workbase([unit("alpha", { panes: [working] })])], [working]),
			),
		).toEqual([])
	})

	test("unmanaged_session offers adoption into the containing workbase", () => {
		const pane = runtimePane({
			paneId: "w9:p1",
			agentSessionId: "ses_9",
			agentStatus: "working",
			cwd: `${root}/notes`,
		})
		const signal = only(snapshot([workbase([])], [pane]), "unmanaged_session")
		expect(signal.subject.workbase?.root).toBe(root)
		expect(signal.actions[0]).toMatchObject({
			id: "unmanaged_session:herdr:w9:p1/adopt",
			type: "agency",
			payload: {
				actionId: "task-create",
				command: null,
				commandTemplate: ["agency", "task", "create", "<id>"],
				bindRuntime: { paneId: "w9:p1", agentSessionId: "ses_9" },
			},
		})
	})

	test("unmanaged_session skips orchestration panes and non-agent panes", () => {
		const epic = runtimePane({
			paneId: "w1:p1",
			agentStatus: "working",
			cwd: `${root}/epics/big`,
		})
		const shell = runtimePane({ paneId: "w1:p2", agent: null, cwd: "/tmp" })
		expect(kinds(snapshot([workbase([])], [epic, shell]))).toEqual([])
	})

	test("unmanaged_session outside workbases adopts into the default only", () => {
		const pane = runtimePane({
			paneId: "w9:p1",
			agentStatus: "working",
			cwd: "/elsewhere",
		})
		const withDefault = only(
			snapshot([workbase([])], [pane]),
			"unmanaged_session",
		)
		expect(withDefault.actions.map((action) => action.type)).toEqual([
			"agency",
			"runtime",
		])
		const withoutDefault = only(
			snapshot([workbase([], { isDefault: false })], [pane]),
			"unmanaged_session",
		)
		expect(withoutDefault.subject.workbase).toBeNull()
		expect(withoutDefault.actions.map((action) => action.type)).toEqual([
			"runtime",
		])
	})
})
