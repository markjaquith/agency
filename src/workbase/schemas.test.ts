import { describe, expect, test } from "bun:test"
import { Schema } from "@effect/schema"
import {
	EntityId,
	EpicFrontmatter,
	PhaseFrontmatter,
	TaskFrontmatter,
	WorkbaseConfig,
} from "./schemas"

describe("body-of-work descriptions", () => {
	test("accepts descriptions on epics, tasks, and phases", () => {
		const epic = Schema.decodeUnknownSync(EpicFrontmatter)({
			ticketUrl: "https://example.com/epic",
			description: "Coordinate the rollout.",
			repos: [{ repo: "agency", ref: "main" }],
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
			repos: [{ repo: "agency", ref: "main" }],
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

describe("schema boundaries", () => {
	const rejects = <S extends Schema.Schema.AnyNoContext>(
		schema: S,
		input: unknown,
	) => {
		expect(() =>
			Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(input),
		).toThrow()
	}

	test("rejects invalid boundary values", () => {
		const cases = [
			{
				name: "unsupported config version",
				schema: WorkbaseConfig,
				input: { version: 1 },
			},
			{
				name: "excess config fields",
				schema: WorkbaseConfig,
				input: { version: 2, legacy: true },
			},
			{
				name: "invalid entity ID",
				schema: EntityId,
				input: "invalid/id",
			},
			{
				name: "empty epic repositories",
				schema: EpicFrontmatter,
				input: {
					ticketUrl: "https://example.com/epic",
					repos: [],
					tasks: [],
				},
			},
			{
				name: "mixed task union",
				schema: TaskFrontmatter,
				input: {
					ticketUrl: "https://example.com/task",
					phases: [],
					repo: "agency",
					branch: "task/mixed",
					base: "main",
					pr: null,
				},
			},
			{
				name: "single-phase task missing pr",
				schema: TaskFrontmatter,
				input: {
					ticketUrl: "https://example.com/task",
					repo: "agency",
					branch: "task/missing-pr",
					base: "main",
				},
			},
			{
				name: "invalid phase PR URL",
				schema: PhaseFrontmatter,
				input: {
					repo: "agency",
					branch: "task/invalid-pr",
					base: "main",
					pr: "https://example.com/pull/1",
				},
			},
		] as const

		for (const fixture of cases) {
			expect(
				() => rejects(fixture.schema, fixture.input),
				fixture.name,
			).not.toThrow()
		}
	})
})
