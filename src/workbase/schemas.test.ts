import { describe, expect, test } from "bun:test"
import { Schema } from "@effect/schema"
import { EpicFrontmatter, PhaseFrontmatter, TaskFrontmatter } from "./schemas"

describe("body-of-work descriptions", () => {
	test("accepts descriptions on epics, tasks, and phases", () => {
		const epic = Schema.decodeUnknownSync(EpicFrontmatter)({
			ticketUrl: "https://example.com/epic",
			description: "Coordinate the rollout.",
			repos: ["agency"],
			tasks: [],
		})
		const singlePhaseTask = Schema.decodeUnknownSync(TaskFrontmatter)({
			ticketUrl: "https://example.com/task",
			description: "Deliver the rollout.",
			repo: "agency",
			branch: "task/rollout",
			base: "main",
			pr: null,
		})
		const multiPhaseTask = Schema.decodeUnknownSync(TaskFrontmatter)({
			ticketUrl: "https://example.com/task",
			description: "Deliver the rollout in phases.",
			phases: [],
		})
		const phase = Schema.decodeUnknownSync(PhaseFrontmatter)({
			description: "Introduce the service contract.",
			repo: "agency",
			branch: "task/contract",
			base: "main",
			pr: null,
		})

		expect(epic.description).toBe("Coordinate the rollout.")
		expect(singlePhaseTask.description).toBe("Deliver the rollout.")
		expect(multiPhaseTask.description).toBe("Deliver the rollout in phases.")
		expect(phase.description).toBe("Introduce the service contract.")
	})

	test("allows omitted descriptions for existing documents", () => {
		const epic = Schema.decodeUnknownSync(EpicFrontmatter)({
			ticketUrl: "https://example.com/epic",
			repos: ["agency"],
			tasks: [],
		})

		expect(epic.description).toBeUndefined()
	})

	test("rejects an empty description when present", () => {
		expect(() =>
			Schema.decodeUnknownSync(PhaseFrontmatter)({
				description: "",
				repo: "agency",
				branch: "task/contract",
				base: "main",
				pr: null,
			}),
		).toThrow()
	})
})
