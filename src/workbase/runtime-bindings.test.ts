import { describe, expect, test } from "bun:test"
import { runtimePane } from "../test-utils"
import type { RuntimePane, RuntimeSnapshot } from "./runtime"
import {
	executionUnitPaths,
	reconcileRuntime,
	type RuntimeBinding,
} from "./runtime-bindings"

const alphaPaths = executionUnitPaths("/wb", { taskId: "alpha" }, "agency")
const betaPaths = executionUnitPaths("/wb", { taskId: "beta" }, "agency")
const unitsFor = (...paths: (typeof alphaPaths & { id: string })[]) =>
	paths.map((path) => ({
		id: path.id,
		directories: [path.directory],
		checkoutPaths: [path.checkoutPath],
	}))
const units = unitsFor(
	{ id: "execution-unit:task/alpha", ...alphaPaths },
	{ id: "execution-unit:task/beta", ...betaPaths },
)
const inAlpha = alphaPaths.checkoutPath

const reconcileBinding = (item: RuntimeBinding, live: RuntimeSnapshot) =>
	reconcileRuntime([item], live, units).bindings[0]!

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

	test("adopts an unknown session from the bound pane while it works in the unit", () => {
		expect(
			reconcileBinding(
				binding({ agentSessionId: null }),
				snapshot(
					runtimePane({
						paneId: "w1:p1",
						agentSessionId: "ses_z",
						foregroundCwd: inAlpha,
					}),
				),
			).state,
		).toBe("live")
		expect(
			reconcileBinding(
				binding({ agentSessionId: null }),
				snapshot(
					runtimePane({
						paneId: "w1:p1",
						agentSessionId: "ses_z",
						cwd: inAlpha,
					}),
					runtimePane({ paneId: "w3:p1", agentSessionId: "ses_z" }),
				),
			).state,
		).toBe("duplicated")
		expect(
			reconcileBinding(
				binding(),
				snapshot(
					runtimePane({ paneId: "w1:p1", agentSessionId: null, cwd: inAlpha }),
				),
			).state,
		).toBe("live")
	})

	test("does not adopt a reused pane whose agent works outside the unit", () => {
		for (const pane of [
			runtimePane({
				paneId: "w1:p1",
				agentSessionId: "ses_z",
				cwd: "/elsewhere",
			}),
			runtimePane({ paneId: "w1:p1", cwd: betaPaths.checkoutPath }),
			runtimePane({ paneId: "w1:p1" }),
		]) {
			const result = reconcileBinding(
				binding({ agentSessionId: null }),
				snapshot(pane),
			)
			expect(result.state).toBe("gone")
			expect(paneIds(result.panes)).toEqual(["w1:p1"])
		}
		// A binding for a unit that no longer exists has no paths to confirm it.
		expect(
			reconcileRuntime(
				[binding({ agentSessionId: null })],
				snapshot(runtimePane({ paneId: "w1:p1", cwd: inAlpha })),
				[],
			).bindings[0]!.state,
		).toBe("gone")
	})

	test("gives a shared pane to the latest fallback binding", () => {
		const older = binding({
			agentSessionId: null,
			boundAt: "2026-10-16T00:00:00.000Z",
		})
		const newer = binding({
			unit: "execution-unit:task/beta",
			agentSessionId: null,
			boundAt: "2026-10-16T01:00:00.000Z",
		})
		const shared = unitsFor({
			id: "execution-unit:task/alpha",
			directory: "/wb",
			checkoutPath: "/wb",
		}).concat(unitsFor({ id: "execution-unit:task/beta", ...betaPaths }))
		const result = reconcileRuntime(
			[older, newer],
			snapshot(runtimePane({ paneId: "w1:p1", cwd: betaPaths.checkoutPath })),
			shared,
		)
		expect(
			result.bindings.map((item) => [item.binding.unit, item.state]),
		).toEqual([
			["execution-unit:task/alpha", "gone"],
			["execution-unit:task/beta", "live"],
		])
		expect(paneIds(result.bindings[0]!.panes)).toEqual(["w1:p1"])
	})

	test("is gone when the pane closed, lost its agent, or hosts another session", () => {
		expect(reconcileBinding(binding(), snapshot()).state).toBe("gone")
		const shell = reconcileBinding(
			binding({ agentSessionId: null }),
			snapshot(runtimePane({ paneId: "w1:p1", agent: null, cwd: inAlpha })),
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
		expect(result.inferred.map((item) => item.matchedPath)).toEqual([
			"foregroundCwd",
			"cwd",
		])
	})

	test("falls back to the pane directory when the foreground runs elsewhere", () => {
		const result = reconcileRuntime(
			[],
			snapshot(
				runtimePane({
					paneId: "w1:p1",
					cwd: "/wb/tasks/alpha",
					foregroundCwd: "/elsewhere/prewarm",
				}),
			),
			units,
		)
		expect(result.inferred).toMatchObject([
			{
				unit: "execution-unit:task/alpha",
				matchedBy: "directory",
				matchedPath: "cwd",
			},
		])
		expect(result.unmanaged).toEqual([])
	})
})
