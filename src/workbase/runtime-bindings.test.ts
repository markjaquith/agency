import { describe, expect, test } from "bun:test"
import { runtimePane } from "../test-utils"
import type { RuntimePane, RuntimeSnapshot } from "./runtime"
import {
	executionUnitPaths,
	reconcileRuntime,
	type RuntimeBinding,
} from "./runtime-bindings"

const reconcileBinding = (item: RuntimeBinding, live: RuntimeSnapshot) =>
	reconcileRuntime([item], live, []).bindings[0]!

const binding = (fields: Partial<RuntimeBinding> = {}): RuntimeBinding => ({
	version: 1,
	workbase: "/wb",
	unit: "execution-unit:task/alpha",
	runtime: "herdr",
	paneId: "w1:p1",
	tabId: "w1:t1",
	workspaceId: "w1",
	agent: "opencode",
	agentSessionId: "ses_a",
	agencySessionId: "1-2",
	boundAt: "2026-10-16T00:00:00.000Z",
	...fields,
})

const snapshot = (...panes: RuntimePane[]): RuntimeSnapshot => ({
	runtime: "herdr",
	workspaces: [],
	tabs: [],
	panes,
})

const paneIds = (panes: readonly RuntimePane[]) => panes.map((p) => p.paneId)

describe("runtime binding reconciliation", () => {
	test("is live when the agent session remains in the bound pane", () => {
		const result = reconcileBinding(
			binding(),
			snapshot(runtimePane({ paneId: "w1:p1", agentSessionId: "ses_a" })),
		)
		expect(result.state).toBe("live")
		expect(paneIds(result.panes)).toEqual(["w1:p1"])
	})

	test("is moved when the agent session appears in exactly one other pane", () => {
		const result = reconcileBinding(
			binding(),
			snapshot(
				runtimePane({ paneId: "w1:p1", agent: null }),
				runtimePane({ paneId: "w2:p7", agentSessionId: "ses_a" }),
			),
		)
		expect(result.state).toBe("moved")
		expect(paneIds(result.panes)).toEqual(["w2:p7"])
	})

	test("is duplicated when one agent session is visible in several panes", () => {
		const result = reconcileBinding(
			binding(),
			snapshot(
				runtimePane({ paneId: "w1:p1", agentSessionId: "ses_a" }),
				runtimePane({ paneId: "w1:p2", agentSessionId: "ses_a" }),
			),
		)
		expect(result.state).toBe("duplicated")
		expect(paneIds(result.panes)).toEqual(["w1:p1", "w1:p2"])
	})

	test("adopts an unknown session from the bound pane", () => {
		expect(
			reconcileBinding(
				binding({ agentSessionId: null }),
				snapshot(runtimePane({ paneId: "w1:p1", agentSessionId: "ses_z" })),
			).state,
		).toBe("live")
		expect(
			reconcileBinding(
				binding({ agentSessionId: null }),
				snapshot(
					runtimePane({ paneId: "w1:p1", agentSessionId: "ses_z" }),
					runtimePane({ paneId: "w3:p1", agentSessionId: "ses_z" }),
				),
			).state,
		).toBe("duplicated")
		expect(
			reconcileBinding(
				binding(),
				snapshot(runtimePane({ paneId: "w1:p1", agentSessionId: null })),
			).state,
		).toBe("live")
	})

	test("is gone when the pane closed, lost its agent, or hosts another session", () => {
		expect(reconcileBinding(binding(), snapshot()).state).toBe("gone")
		const shell = reconcileBinding(
			binding({ agentSessionId: null }),
			snapshot(runtimePane({ paneId: "w1:p1", agent: null })),
		)
		expect(shell.state).toBe("gone")
		expect(paneIds(shell.panes)).toEqual(["w1:p1"])
		expect(
			reconcileBinding(
				binding(),
				snapshot(runtimePane({ paneId: "w1:p1", agentSessionId: "ses_other" })),
			).state,
		).toBe("gone")
	})

	test("infers unbound agent panes by the deepest matching unit path", () => {
		const task = executionUnitPaths("/wb", { taskId: "alpha" }, "agency")
		const phase = executionUnitPaths(
			"/wb",
			{ taskId: "multi", phaseId: "build" },
			"agency",
		)
		const units = [
			{
				id: "execution-unit:task/alpha",
				directories: [task.directory],
				checkoutPaths: [task.checkoutPath],
			},
			{
				id: "execution-unit:phase/multi/build",
				directories: [phase.directory],
				checkoutPaths: [phase.checkoutPath],
			},
		]
		const result = reconcileRuntime(
			[binding({ paneId: "w1:p1" })],
			snapshot(
				runtimePane({
					paneId: "w1:p1",
					agentSessionId: "ses_a",
					cwd: "/wb/tasks/alpha",
				}),
				runtimePane({
					paneId: "w1:p2",
					cwd: "/wb/tasks/alpha",
					foregroundCwd: "/wb/tasks/alpha/code/agency/src",
				}),
				runtimePane({ paneId: "w1:p3", cwd: "/wb/tasks/multi/phases/build" }),
				runtimePane({ paneId: "w1:p4", cwd: "/wb/tasks/alphabet" }),
				runtimePane({ paneId: "w1:p5", agent: null, cwd: "/wb/tasks/alpha" }),
			),
			units,
		)
		expect(result.bindings.map((item) => item.state)).toEqual(["live"])
		expect(
			result.inferred.map((item) => [
				item.unit,
				item.matchedBy,
				item.pane.paneId,
			]),
		).toEqual([
			["execution-unit:task/alpha", "checkout", "w1:p2"],
			["execution-unit:phase/multi/build", "directory", "w1:p3"],
		])
		expect(paneIds(result.unmanaged)).toEqual(["w1:p4"])
	})
})
