import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { AttentionSignal, type SupervisorAction } from "../attention-schema"
import type { LivePullRequest } from "../services/PullRequestStatusService"
import { attentionValidators, runtimePane } from "../test-utils"
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
const prUrl = "https://github.com/acme/app/pull/1"
const ticketUrl = "https://example.atlassian.net/browse/CAN-1"

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
	catalogAction("finish-review", ["agency", "review", "finish", taskId]),
	catalogAction("sync", ["agency", "sync", taskId]),
	catalogAction("archive", ["agency", "archive", "task", taskId], false),
]

const ticket = (
	statusCategory: "todo" | "in_progress" | "done",
	provider = "jira",
): TicketRecord => ({
	url: ticketUrl,
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
		url: prUrl,
		prState: "open",
		draft: false,
		review: "none",
		checks: "pending",
		mergeable: "mergeable",
		mergeState: "BLOCKED",
		headSha: "abc123",
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
		readonly mergeCommand?: readonly string[]
	} = {},
): AttentionUnit => {
	const {
		archived = false,
		phaseId,
		prState,
		live = null,
		panes,
		mergeCommand = null,
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
		review: false,
		status: "working",
		revision: archived ? null : "a".repeat(64),
		pr: prState
			? {
					url: prUrl,
					repository: "acme/app",
					recordedState: prState,
					live,
					mergeCommand,
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
	roots: [root],
	key: root,
	source: "registered",
	isDefault: true,
	error: null,
	jira: { doneStatus: "Done", reopenStatus: "In Progress" },
	units,
	actions: [
		{
			...catalogAction("task-create", []),
			command: null,
			commandTemplate: ["agency", "task", "create", "<id>"],
			inputs: [{ id: "id", label: "Task ID", required: true }],
		},
	],
	claimedPaneIds: units.flatMap((item) => [
		...(item.binding?.panes ?? []).map((pane) => pane.paneId),
		...item.inferred.map((inferred) => inferred.pane.paneId),
	]),
	...fields,
})

const snapshot = (
	workbases: readonly AttentionWorkbase[],
	panes: readonly RuntimePane[] = [],
	fields: Partial<AttentionSnapshot> = {},
): AttentionSnapshot => ({
	runtime: { provider: "herdr", available: true, error: null, panes },
	workbases,
	otherRoots: [],
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

const payloads = (actions: readonly SupervisorAction[]) =>
	actions.map((action) =>
		action.type === "agency"
			? `agency:${action.payload.actionId}`
			: action.type === "runtime"
				? `${action.payload.operation}-${action.payload.target}:${action.payload.id}`
				: action.type,
	)

describe("attention signals", () => {
	test("emit valid, deterministic signals keyed on the resolved root", () => {
		const pane = runtimePane({
			paneId: "w1:p1",
			agentSessionId: "ses_1",
			cwd: `${root}/tasks/alpha`,
		})
		const current = snapshot(
			[
				workbase(
					[
						unit("alpha", { status: "done", prState: "merged", panes: [pane] }),
						unit("beta"),
					],
					{ key: "/real/work" },
				),
			],
			[pane],
		)
		const first = attentionSignals(current)
		expect(first).toEqual(attentionSignals(current))
		expect(first.map((signal) => signal.id)).toEqual([
			"complete_session_open:/real/work:execution-unit:task/alpha",
			"claim_without_session:/real/work:execution-unit:task/beta",
		])
		const { action: validate } = attentionValidators()
		for (const signal of first) {
			expect(() =>
				Schema.decodeUnknownSync(AttentionSignal, {
					onExcessProperty: "error",
				})(signal),
			).not.toThrow()
			for (const action of signal.actions) expect(validate(action)).toBe(true)
		}
	})

	describe("complete_session_open", () => {
		test("closes the tab with exact pane identity preconditions", () => {
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
			expect(payloads(signal.actions)).toEqual([
				"close-tab:w1:t1",
				"focus-pane:w1:p1",
			])
			expect(signal.actions[0]).toMatchObject({ risk: "destructive" })
			expect(signal.actions[0]!.preconditions).toEqual(
				expect.arrayContaining([
					{
						kind: "tab_agent_panes",
						runtime: "herdr",
						tabId: "w1:t1",
						paneIds: ["w1:p1"],
					},
					{
						kind: "pane_matches",
						runtime: "herdr",
						paneId: "w1:p1",
						tabId: "w1:t1",
						cwd: `${root}/tasks/alpha`,
						agentSessionId: "ses_1",
						agentStatuses: ["idle", "done", "blocked"],
					},
				]),
			)
			expect(signal.evidence).toContainEqual({
				source: "runtime",
				label: "binding",
				value: "recorded",
				paneId: "w1:p1",
			})
		})

		test("closes only the pane when the tab hosts other agents", () => {
			const worker = runtimePane({ paneId: "w1:p1", agentSessionId: "ses_1" })
			const other = runtimePane({ paneId: "w1:p2", agentSessionId: "ses_2" })
			const signal = only(
				snapshot(
					[workbase([unit("alpha", { status: "dropped", panes: [worker] })])],
					[worker, other],
				),
				"complete_session_open",
			)
			expect(payloads(signal.actions)[0]).toBe("close-pane:w1:p1")
		})

		test("only focuses a working agent", () => {
			const busy = runtimePane({
				paneId: "w1:p1",
				agentStatus: "working",
				cwd: `${root}/archive/tasks/alpha`,
			})
			const signal = only(
				snapshot(
					[
						workbase([
							unit("alpha", {
								archived: true,
								status: "done",
								inferred: [{ matchedBy: "directory", pane: busy }],
							}),
						]),
					],
					[busy],
				),
				"complete_session_open",
			)
			expect(payloads(signal.actions)).toEqual(["focus-pane:w1:p1"])
			expect(signal.evidence).toEqual(
				expect.arrayContaining([
					{
						source: "runtime",
						label: "binding",
						value: "inferred",
						paneId: "w1:p1",
					},
					{
						source: "runtime",
						label: "matchedBy",
						value: "directory",
						paneId: "w1:p1",
					},
				]),
			)
		})

		test("waits for an open PR or unfinished ticket", () => {
			const pane = runtimePane({ paneId: "w1:p1", agentSessionId: "ses_1" })
			expect(
				kinds(
					snapshot(
						[
							workbase([
								unit("alpha", {
									status: "done",
									prState: "open",
									panes: [pane],
								}),
							]),
						],
						[pane],
					),
				),
			).not.toContain("complete_session_open")
			expect(
				kinds(
					snapshot(
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
					),
				),
			).not.toContain("complete_session_open")
		})
	})

	describe("ticket_status_mismatch", () => {
		test("suggests the configured transition with unit and PR preconditions", () => {
			const signal = only(
				snapshot([
					workbase(
						[
							unit("alpha", {
								status: "done",
								prState: "merged",
								ticket: ticket("in_progress"),
							}),
						],
						{ jira: { doneStatus: "Closed", reopenStatus: "Reopened" } },
					),
				]),
				"ticket_status_mismatch",
			)
			expect(signal.id).toBe(`ticket_status_mismatch:${ticketUrl}`)
			const transition = signal.actions[0]!
			expect(transition).toMatchObject({
				type: "command",
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
						"Closed",
						"--yes",
					],
				},
			})
			expect(transition.preconditions).toEqual(
				expect.arrayContaining([
					{
						kind: "item_status",
						unit: "execution-unit:task/alpha",
						statuses: ["done"],
					},
					{ kind: "pull_request_state", url: prUrl, states: ["merged"] },
				]),
			)
		})

		test("waits until every task sharing the ticket is terminal", () => {
			const shared = ticket("in_progress")
			const current = (sibling: AttentionUnit["status"]) =>
				snapshot([
					workbase([
						unit("config", {
							status: "done",
							prState: "merged",
							ticket: shared,
						}),
						unit("secrets-check", { status: sibling, ticket: shared }),
					]),
				])
			expect(kinds(current("open"))).not.toContain("ticket_status_mismatch")
			const signal = only(current("dropped"), "ticket_status_mismatch")
			expect(signal.subject.item).toBeNull()
			expect(signal.evidence).toContainEqual({
				source: "agency",
				label: "status",
				value: "dropped",
				unit: "execution-unit:task/secrets-check",
			})
		})

		test("rejects a done unit with an unmerged PR", () => {
			const shared = ticket("todo")
			expect(
				kinds(
					snapshot([
						workbase([
							unit("one", {
								status: "done",
								prState: "merged",
								ticket: shared,
							}),
							unit("two", { status: "done", prState: "open", ticket: shared }),
						]),
					]),
				),
			).not.toContain("ticket_status_mismatch")
		})

		test("flags a done ticket only when no sharing unit is done", () => {
			const done = ticket("done", "github")
			const signal = only(
				snapshot([workbase([unit("alpha", { status: "open", ticket: done })])]),
				"ticket_status_mismatch",
			)
			expect(payloads(signal.actions)).toEqual(["command", "open_url"])
			expect(signal.actions[0]!.payload).toMatchObject({
				argv: ["gh", "issue", "reopen", ticketUrl],
			})
			expect(
				kinds(
					snapshot([
						workbase([
							unit("alpha", {
								status: "done",
								prState: "merged",
								ticket: done,
							}),
							unit("follow-up", { status: "open", ticket: done }),
						]),
					]),
				),
			).not.toContain("ticket_status_mismatch")
		})

		test("evaluates a multi-phase task once with fixed evidence labels", () => {
			const shared = ticket("in_progress")
			const signal = only(
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
			expect(signal.subject.item).toMatchObject({
				unit: null,
				kind: "task",
				taskId: "multi",
			})
			expect(signal.evidence).toContainEqual({
				source: "agency",
				label: "status",
				value: "done",
				unit: "execution-unit:phase/multi/two",
				phaseId: "two",
			})
		})

		test("groups sharing units across workbases", () => {
			const shared = ticket("in_progress")
			expect(
				kinds(
					snapshot([
						workbase([
							unit("alpha", {
								status: "done",
								prState: "merged",
								ticket: shared,
							}),
						]),
						workbase([unit("beta", { status: "open", ticket: shared })], {
							ref: { id: "wb-2", name: "other", root: "/other" },
							roots: ["/other"],
							key: "/other",
							isDefault: false,
						}),
					]),
				),
			).not.toContain("ticket_status_mismatch")
		})
	})

	test("pr_merged_item_open uses the live PR state and suggests sync", () => {
		const signal = only(
			snapshot([
				workbase([
					unit("alpha", {
						prState: "open",
						live: livePr({ prState: "merged" }),
					}),
				]),
			]),
			"pr_merged_item_open",
		)
		expect(signal.actions[0]).toMatchObject({
			type: "agency",
			payload: {
				actionId: "sync",
				selector: { task: "alpha" },
				command: ["agency", "sync", "alpha"],
				commandTemplate: null,
				values: {},
				cwd: root,
			},
		})
	})

	describe("pr_ready_to_merge", () => {
		const make = (live: LivePullRequest) =>
			snapshot([
				workbase([
					unit("alpha", {
						prState: "open",
						live,
						panes: [runtimePane({ paneId: "w1:p1", agentStatus: "working" })],
						mergeCommand: [
							"gh",
							"pr",
							"merge",
							prUrl,
							"--squash",
							"--match-head-commit",
							"abc123",
						],
					}),
				]),
			])
		const ready = { review: "approved", checks: "passing", mergeState: "CLEAN" }

		test("requires approval, passing checks, and a clean merge state", () => {
			for (const live of [
				livePr({ ...ready, review: "none" } as Partial<LivePullRequest>),
				livePr({ ...ready, checks: "none" } as Partial<LivePullRequest>),
				livePr({ ...ready, mergeState: "BLOCKED" } as Partial<LivePullRequest>),
				livePr({ ...ready, mergeState: null } as Partial<LivePullRequest>),
				livePr({ ...ready, draft: true } as Partial<LivePullRequest>),
				livePr({ ...ready, headSha: null } as Partial<LivePullRequest>),
			]) {
				expect(kinds(make(live))).not.toContain("pr_ready_to_merge")
			}
		})

		test("merges only the reviewed head", () => {
			const signal = only(
				make(livePr(ready as Partial<LivePullRequest>)),
				"pr_ready_to_merge",
			)
			expect(signal.actions[0]).toMatchObject({
				type: "command",
				risk: "destructive",
				payload: {
					argv: [
						"gh",
						"pr",
						"merge",
						prUrl,
						"--squash",
						"--match-head-commit",
						"abc123",
					],
				},
			})
			expect(signal.actions[0]!.preconditions).toContainEqual({
				kind: "pull_request_head",
				url: prUrl,
				sha: "abc123",
			})
		})
	})

	describe("claim_without_session", () => {
		test("offers resume and drop with PR evidence", () => {
			const signal = only(
				snapshot([workbase([unit("alpha")])]),
				"claim_without_session",
			)
			expect(payloads(signal.actions)).toEqual(["agency:work", "agency:drop"])
			expect(signal.evidence).toContainEqual({
				source: "pull_request",
				label: "state",
				value: "none",
			})
			expect(signal.actions[0]!.preconditions).toContainEqual({
				kind: "item_status",
				unit: "execution-unit:task/alpha",
				statuses: ["working"],
			})
		})

		test("is normal while a PR is open or merged", () => {
			expect(
				kinds(snapshot([workbase([unit("alpha", { prState: "open" })])])),
			).toEqual([])
			expect(
				kinds(snapshot([workbase([unit("alpha", { prState: "merged" })])])),
			).toEqual(["pr_merged_item_open"])
		})

		test("offers finish-review rather than drop for review tasks", () => {
			const signal = only(
				snapshot([workbase([unit("review-pr-1", { review: true })])]),
				"claim_without_session",
			)
			expect(payloads(signal.actions)).toEqual([
				"agency:work",
				"agency:finish-review",
			])
		})

		test("needs a live runtime", () => {
			const current = snapshot([workbase([unit("alpha")])], [], {
				runtime: { provider: null, available: false, error: null, panes: [] },
			})
			expect(kinds(current)).toEqual([])
		})
	})

	describe("duplicate_session", () => {
		const copy = runtimePane({ paneId: "w1:p1", agentSessionId: "ses_1" })
		const bound = runtimePane({
			paneId: "w1:p2",
			tabId: "w1:t2",
			agentSessionId: "ses_1",
		})

		test("closes the copy when a binding says which pane to keep", () => {
			const base = unit("alpha", { panes: [bound] })
			const signal = only(
				snapshot(
					[
						workbase([
							{
								...base,
								binding: {
									...base.binding!,
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
			expect(payloads(signal.actions)).toEqual([
				"focus-pane:w1:p1",
				"focus-pane:w1:p2",
				"close-pane:w1:p1",
			])
		})

		test("only focuses when nothing identifies the pane to keep", () => {
			const signal = only(
				snapshot([workbase([])], [copy, bound]),
				"duplicate_session",
			)
			expect(payloads(signal.actions)).toEqual([
				"focus-pane:w1:p1",
				"focus-pane:w1:p2",
			])
			const focused = only(
				snapshot([workbase([])], [copy, { ...bound, focused: true }]),
				"duplicate_session",
			)
			expect(payloads(focused.actions)).toContain("close-pane:w1:p1")
		})
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
		const blocked = runtimePane({ paneId: "w1:p1", agentStatus: "blocked" })
		const signal = only(
			snapshot([workbase([unit("alpha", { panes: [blocked] })])], [blocked]),
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

	describe("unmanaged_session", () => {
		test("offers adoption into the containing workbase", () => {
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
					selector: null,
					command: null,
					commandTemplate: ["agency", "task", "create", "<id>"],
					bindRuntime: { paneId: "w9:p1", agentSessionId: "ses_9" },
				},
			})
		})

		test("matches workbases through either recorded root", () => {
			const pane = runtimePane({
				paneId: "w9:p1",
				agentStatus: "working",
				cwd: "/real/work/notes",
			})
			const signal = only(
				snapshot(
					[workbase([], { roots: [root, "/real/work"], isDefault: false })],
					[pane],
				),
				"unmanaged_session",
			)
			expect(signal.subject.workbase?.root).toBe(root)
		})

		test("skips orchestration, root, and non-agent panes", () => {
			const panes = [
				runtimePane({ paneId: "w1:p1", agentStatus: "working", cwd: root }),
				runtimePane({
					paneId: "w1:p2",
					agentStatus: "working",
					cwd: `${root}/epics/big`,
				}),
				runtimePane({ paneId: "w1:p3", agent: null, cwd: "/tmp" }),
			]
			expect(kinds(snapshot([workbase([])], panes))).toEqual([])
		})

		test("skips panes that belong to another, uninspected workbase", () => {
			const pane = runtimePane({
				paneId: "w9:p1",
				agentStatus: "working",
				cwd: "/other/notes",
			})
			expect(
				kinds(snapshot([workbase([])], [pane], { otherRoots: ["/other"] })),
			).toEqual([])
		})

		test("outside workbases adopts into the default only", () => {
			const pane = runtimePane({
				paneId: "w9:p1",
				agentStatus: "working",
				cwd: "/elsewhere",
			})
			expect(
				payloads(
					only(snapshot([workbase([])], [pane]), "unmanaged_session").actions,
				),
			).toEqual(["agency:task-create", "focus-pane:w9:p1"])
			const withoutDefault = only(
				snapshot([workbase([], { isDefault: false })], [pane]),
				"unmanaged_session",
			)
			expect(withoutDefault.subject.workbase).toBeNull()
			expect(payloads(withoutDefault.actions)).toEqual(["focus-pane:w9:p1"])
		})
	})
})
