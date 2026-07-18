import { describe, expect, test } from "bun:test"
import { findDependencyCycles, validateDependencies } from "./dependency-graph"

describe("dependency graph", () => {
	test("accepts empty and acyclic dependency graphs", () => {
		expect(validateDependencies([], "Tasks")).toBeUndefined()
		expect(
			validateDependencies(
				[
					{ id: "build" },
					{ id: "test", dependsOn: ["build"] },
					{ id: "ship", dependsOn: ["build", "test"] },
				],
				"Tasks",
			),
		).toBeUndefined()
		expect(
			findDependencyCycles([
				{ id: "build" },
				{ id: "test", dependsOn: ["build"] },
			]),
		).toEqual([])
	})

	test("reports duplicate, self, and unknown dependencies precisely", () => {
		expect(validateDependencies([{ id: "one" }, { id: "one" }], "Tasks")).toBe(
			"Tasks IDs must be unique",
		)
		expect(
			validateDependencies([{ id: "one", dependsOn: ["one"] }], "Tasks"),
		).toBe("Task 'one' cannot depend on itself")
		expect(
			validateDependencies([{ id: "one", dependsOn: ["missing"] }], "Phases"),
		).toBe("Unknown phase dependency 'missing'")
	})

	test("detects cycles deterministically across disconnected graphs", () => {
		const nodes = [
			{ id: "delta", dependsOn: ["charlie"] },
			{ id: "bravo", dependsOn: ["alpha"] },
			{ id: "charlie", dependsOn: ["delta"] },
			{ id: "alpha", dependsOn: ["bravo"] },
		]

		expect(findDependencyCycles(nodes)).toEqual(["bravo", "delta"])
		expect(validateDependencies(nodes, "Tasks")).toBe(
			"Task dependency cycle includes 'bravo'",
		)
	})
})
