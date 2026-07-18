import { describe, expect, test } from "bun:test"
import {
	WORK_STATUS_TRANSITIONS,
	aggregateProgress,
	canTransitionStatus,
	isDependencySatisfied,
	isTerminalStatus,
	readinessState,
} from "./readiness"
import type { WorkStatus } from "./workbase/schemas"

const statuses: readonly WorkStatus[] = [
	"open",
	"working",
	"delegated",
	"done",
	"dropped",
]

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

	test("classifies every status and dependency state", () => {
		expect(statuses.map(isTerminalStatus)).toEqual([
			false,
			false,
			false,
			true,
			true,
		])
		expect([...statuses, undefined].map(isDependencySatisfied)).toEqual([
			false,
			false,
			false,
			true,
			false,
			false,
		])
	})

	test("covers the complete status transition matrix", () => {
		for (const from of statuses) {
			for (const to of statuses) {
				expect(canTransitionStatus(from, to), `${from} -> ${to}`).toBe(
					WORK_STATUS_TRANSITIONS[from].includes(to as never),
				)
			}
		}
	})

	test("rolls every status-precedence branch into aggregate progress", () => {
		const cases: readonly [readonly WorkStatus[], WorkStatus][] = [
			[[], "open"],
			[["done", "done"], "done"],
			[["done", "dropped"], "dropped"],
			[["open", "working", "delegated"], "working"],
			[["open", "delegated"], "delegated"],
			[["open", "done"], "open"],
		]

		for (const [input, status] of cases) {
			const result = aggregateProgress(input)
			expect(result.status, input.join(",") || "empty").toBe(status)
			expect(result.total).toBe(input.length)
			expect(result.terminal).toBe(
				input.filter((value) => value === "done" || value === "dropped").length,
			)
			for (const value of statuses) {
				expect(result[value]).toBe(
					input.filter((candidate) => candidate === value).length,
				)
			}
		}
	})

	test("deduplicates and sorts blockers while honoring explicit readiness", () => {
		expect(
			readinessState(
				"open",
				[{ id: "task:z" }, { id: "task:a" }, { id: "task:z" }],
				true,
			),
		).toEqual({
			ready: true,
			blocked: false,
			blockedBy: ["task:a", "task:z"],
			terminal: false,
		})
	})
})
