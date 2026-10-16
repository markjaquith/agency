import { describe, expect, test } from "bun:test"
import type {
	AttentionReport,
	AttentionSignal,
	AttentionSignalKind,
	SupervisorAction,
} from "../attention-schema"
import type { RuntimeSnapshot } from "./runtime"
import {
	superviseModel,
	UNMANAGED_GROUP,
	type TriageEntry,
} from "./supervise-view"

const root = "/work"
const canonical = "/private/work"
const workbase = { id: "main", name: "Main", root }

const focus = (paneId: string, signalId: string): SupervisorAction => ({
	version: 1,
	id: `${signalId}/focus-pane-${paneId}`,
	type: "runtime",
	title: `Focus pane ${paneId}`,
	rationale: "Look.",
	risk: "reversible",
	subject: {
		workbase,
		item: null,
		runtime: [],
		pullRequest: null,
		ticket: null,
	},
	preconditions: [],
	payload: { runtime: "herdr", operation: "focus", target: "pane", id: paneId },
})

const pane = (paneId: string) => ({
	runtime: "herdr" as const,
	paneId,
	tabId: "w1:t1",
	workspaceId: "w1",
	agent: "opencode",
	agentSessionId: null,
})

const unitSignal = (
	kind: AttentionSignalKind,
	unit: string,
	options: {
		readonly paneId?: string
		readonly agentStatus?: string
		readonly title?: string
	} = {},
): AttentionSignal => {
	const id = `${kind}:${canonical}:execution-unit:task/${unit}${options.paneId ? `:${options.paneId}` : ""}`
	return {
		id,
		kind,
		title: options.title ?? `${unit} ${kind}`,
		subject: {
			workbase,
			item: {
				unit: `execution-unit:task/${unit}`,
				kind: "task",
				taskId: unit,
				path: `${root}/tasks/${unit}/TASK.md`,
				archived: false,
			},
			runtime: options.paneId ? [pane(options.paneId)] : [],
			pullRequest: null,
			ticket: null,
		},
		evidence: options.agentStatus
			? [
					{
						source: "runtime",
						label: "agentStatus",
						value: options.agentStatus,
					},
				]
			: [],
		actions: options.paneId ? [focus(options.paneId, id)] : [],
	}
}

const unmanaged = (paneId: string): AttentionSignal => {
	const id = `unmanaged_session:herdr:${paneId}`
	return {
		id,
		kind: "unmanaged_session",
		title: `Pane ${paneId} runs opencode outside any Agency item`,
		subject: {
			workbase,
			item: null,
			runtime: [pane(paneId)],
			pullRequest: null,
			ticket: null,
		},
		evidence: [],
		actions: [focus(paneId, id)],
	}
}

const report = (signals: AttentionSignal[]): AttentionReport => ({
	version: 1,
	generatedAt: "2026-10-16T00:00:00.000Z",
	runtime: { provider: "herdr", available: true, error: null },
	workbases: [
		{ ...workbase, source: "registered", available: true, error: null },
		{
			id: "broken",
			name: null,
			root: "/broken",
			source: "registered",
			available: false,
			error: "bad config",
		},
	],
	signals,
	summary: { total: signals.length, kinds: {} },
})

const snapshot: RuntimeSnapshot = {
	runtime: "herdr",
	workspaces: [{ workspaceId: "w1", label: "Main", focused: true }],
	tabs: [{ tabId: "w1:t1", workspaceId: "w1", label: "alpha", focused: true }],
	panes: [],
}

const empty = { snoozes: [], dismissals: [] }

describe("supervise view model", () => {
	test("merges a unit's signals into one ranked item keyed like triage", () => {
		const model = superviseModel(
			report([
				unitSignal("claim_without_session", "beta"),
				unitSignal("pr_ready_to_merge", "alpha"),
				unitSignal("agent_waiting", "alpha", {
					paneId: "w1:p1",
					agentStatus: "blocked",
				}),
				unmanaged("w1:p9"),
			]),
			{ snapshot, state: empty },
		)
		expect(model.groups.map((group) => [group.label, group.error])).toEqual([
			["Main", null],
			["broken", "bad config"],
			["Unmanaged", null],
		])
		const [alpha, beta] = model.groups[0]!.items
		expect(alpha).toMatchObject({
			key: `${canonical}:execution-unit:task/alpha`,
			label: "alpha",
			badge: { label: "Blocked", tone: "red" },
			location: "Main › alpha",
			summary: "alpha agent_waiting (+1 more)",
		})
		expect(alpha!.actions.map((action) => action.title)).toEqual([
			"Focus pane w1:p1",
		])
		expect(beta).toMatchObject({ badge: { label: "Stale" } })
		expect(model.groups[2]!.items[0]).toMatchObject({
			key: "herdr:w1:p9",
			groupKey: UNMANAGED_GROUP,
			badge: { label: "Unmanaged" },
		})
		expect(model.total).toBe(3)
	})

	test("deduplicates identical actions across signals", () => {
		const first = unitSignal("agent_waiting", "alpha", {
			paneId: "w1:p1",
			agentStatus: "idle",
		})
		const second = {
			...unitSignal("complete_session_open", "alpha"),
			actions: [focus("w1:p1", "other")],
		}
		const [item] = superviseModel(report([first, second]), { state: empty })
			.groups[0]!.items
		expect(item!.actions).toHaveLength(1)
		expect(item!.badge.label).toBe("Needs You")
	})

	test("hides snoozed items and dismissed items until they change", () => {
		const signals = [
			unitSignal("pr_ready_to_merge", "alpha"),
			unitSignal("claim_without_session", "beta"),
		]
		const first = superviseModel(report(signals), { state: empty })
		const [alpha, beta] = first.groups[0]!.items
		const now = new Date("2026-10-16T12:00:00.000Z")
		const state = {
			snoozes: [
				{
					version: 1 as const,
					at: now.toISOString(),
					key: alpha!.key,
					actionId: null,
					until: "2026-10-16T13:00:00.000Z",
					reason: null,
				},
			],
			dismissals: [
				{
					version: 1 as const,
					at: now.toISOString(),
					key: beta!.key,
					actionId: null,
					fingerprint: beta!.fingerprint,
					reason: null,
				},
			],
		}
		const hidden = superviseModel(report(signals), { state, now })
		expect(hidden).toMatchObject({ total: 0, snoozed: 1, dismissed: 1 })

		const later = superviseModel(
			report([
				signals[0]!,
				unitSignal("claim_without_session", "beta", { title: "changed" }),
			]),
			{ state, now: new Date("2026-10-16T14:00:00.000Z") },
		)
		expect(later.groups[0]!.items.map((item) => item.label)).toEqual([
			"alpha",
			"beta",
		])
	})

	const entry = (
		key: string,
		fields: Partial<TriageEntry> & {
			readonly status?: string
			readonly actions?: SupervisorAction[]
			readonly modelActionIds?: string[]
			readonly question?: string | null
		} = {},
	): TriageEntry => ({
		key,
		subject: fields.subject ?? null,
		fingerprint: fields.fingerprint ?? `triage-${key}`,
		source: fields.source ?? "fresh",
		evaluatedAt: "2026-10-16T00:00:00.000Z",
		assessment: {
			status: (fields.status ?? "needs_input") as "needs_input",
			summary: `${key} assessed`,
			question: fields.question ?? null,
			actions: fields.actions ?? [],
			modelActionIds: fields.modelActionIds ?? [],
		},
		suppressed: fields.suppressed ?? null,
		error: null,
	})

	test("layers triage over signal items, ranking its actions first", () => {
		const signal = unitSignal("claim_without_session", "alpha")
		const key = `${canonical}:execution-unit:task/alpha`
		const written = { ...focus("w1:p2", "triage:x"), id: "triage:x/focus" }
		const copied = focus("w1:p1", "signal")
		const [item] = superviseModel(report([signal]), {
			state: empty,
			triage: new Map([
				[
					key,
					entry(key, {
						status: "needs_input",
						question: "Which base?",
						actions: [written, copied],
						modelActionIds: [written.id],
					}),
				],
			]),
		}).groups[0]!.items
		expect(item).toMatchObject({
			badge: { label: "Needs You" },
			summary: `${key} assessed — asks: Which base?`,
			fingerprint: `triage-${key}`,
			modelActionIds: [written.id],
			triageActionIds: [written.id, copied.id],
			triage: { source: "fresh", question: "Which base?" },
		})
		expect(item!.actions.map((action) => action.id)).toEqual([
			written.id,
			copied.id,
		])
	})

	test("keeps a more urgent signal badge over triage's", () => {
		const signal = unitSignal("agent_waiting", "alpha", {
			paneId: "w1:p1",
			agentStatus: "blocked",
		})
		const key = `${canonical}:execution-unit:task/alpha`
		const [item] = superviseModel(report([signal]), {
			state: empty,
			triage: new Map([[key, entry(key, { status: "in_progress" })]]),
		}).groups[0]!.items
		expect(item!.badge.label).toBe("Blocked")
	})

	test("adds triage-only items and honors suppression", () => {
		const subjectOf = (unit: string) =>
			unitSignal("claim_without_session", unit).subject
		const model = superviseModel(report([]), {
			state: empty,
			triage: new Map([
				[
					"k:gamma",
					entry("k:gamma", {
						subject: subjectOf("gamma"),
						status: "in_progress",
					}),
				],
				[
					"k:delta",
					entry("k:delta", {
						subject: subjectOf("delta"),
						suppressed: "snoozed",
					}),
				],
				[
					"k:epsilon",
					entry("k:epsilon", {
						subject: subjectOf("epsilon"),
						suppressed: "dismissed",
					}),
				],
				// Cached results without a subject only annotate signal items.
				["k:zeta", entry("k:zeta", { source: "cached" })],
			]),
		})
		expect(model).toMatchObject({ total: 1, snoozed: 1, dismissed: 1 })
		expect(model.groups[0]!.items[0]).toMatchObject({
			key: "k:gamma",
			label: "gamma",
			badge: { label: "Working" },
			summary: "k:gamma assessed",
		})
	})
})
