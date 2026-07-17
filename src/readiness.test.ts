import { describe, expect, test } from "bun:test"
import {
	aggregateProgress,
	canTransitionStatus,
	isDependencySatisfied,
	readinessState,
} from "./readiness"

describe("readiness model", () => {
	test("only done satisfies dependencies and terminal states remain distinct", () => {
		expect(isDependencySatisfied("done")).toBe(true)
		expect(isDependencySatisfied("dropped")).toBe(false)
		expect(readinessState("done", [{ id: "task:one" }])).toEqual({
			ready: false,
			blocked: true,
			blockedBy: ["task:one"],
			terminal: true,
		})
		expect(readinessState("working", [{ id: "claim:self" }])).toEqual({
			ready: false,
			blocked: true,
			blockedBy: ["claim:self"],
			terminal: false,
		})
	})

	test("rolls child statuses into deterministic aggregate progress", () => {
		expect(aggregateProgress(["done", "dropped"])).toEqual({
			status: "dropped",
			total: 2,
			open: 0,
			working: 0,
			delegated: 0,
			done: 1,
			dropped: 1,
			terminal: 2,
		})
	})

	test("requires terminal work to reopen before changing its outcome", () => {
		expect(canTransitionStatus("open", "done")).toBe(true)
		expect(canTransitionStatus("working", "delegated")).toBe(true)
		expect(canTransitionStatus("done", "dropped")).toBe(false)
		expect(canTransitionStatus("dropped", "done")).toBe(false)
		expect(canTransitionStatus("done", "open")).toBe(true)
	})
})
