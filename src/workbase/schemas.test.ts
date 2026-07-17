import { describe, expect, test } from "bun:test"
import { Schema } from "@effect/schema"
import {
	EntityId,
	ClaimRecord,
	EpicFrontmatter,
	PhaseFrontmatter,
	TaskFrontmatter,
	WorkStatus,
	WorkbaseConfig,
	WorkbaseRegistry,
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

	test("allows tasks without an external ticket", () => {
		const task = Schema.decodeUnknownSync(TaskFrontmatter)({
			ticketUrl: null,
			phases: [],
		})

		expect(task.ticketUrl).toBeNull()
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

describe("runner configuration", () => {
	test("accepts named argv commands with resume commands and environment", () => {
		const config = Schema.decodeUnknownSync(WorkbaseConfig)({
			version: 2,
			runners: {
				custom: {
					command: ["agent", "{prompt}"],
					resumeCommand: ["agent", "resume", "{sessionId}"],
					environment: { CUSTOM_TARGET: "{target}" },
				},
			},
		})

		expect(config.runners?.custom?.command).toEqual(["agent", "{prompt}"])
	})

	test("rejects shell strings in place of argv arrays", () => {
		expect(() =>
			Schema.decodeUnknownSync(WorkbaseConfig)({
				version: 2,
				runners: { custom: { command: "agent {prompt}" } },
			}),
		).toThrow()
	})
})

describe("delivery configuration", () => {
	test("accepts an argv-based create and query provider", () => {
		const config = Schema.decodeUnknownSync(WorkbaseConfig)({
			version: 2,
			delivery: {
				provider: "forge",
				remote: "upstream",
				createCommand: ["forge", "create", "{branch}"],
				queryCommand: ["forge", "query", "{identifier}"],
			},
		})
		expect(config.delivery?.remote).toBe("upstream")
	})

	test("accepts normalized non-GitHub pull request records", () => {
		const phase = Schema.decodeUnknownSync(PhaseFrontmatter)({
			repo: "agency",
			branch: "feat/example",
			base: "main",
			pr: {
				provider: "forge",
				repository: "example/agency",
				identifier: "17",
				url: "https://forge.example/example/agency/pulls/17",
				state: "open",
				draft: false,
				merged: false,
			},
		})
		expect(phase.pr && typeof phase.pr !== "string" && phase.pr.provider).toBe(
			"forge",
		)
	})
})

describe("work status", () => {
	const supportedStatuses: Record<WorkStatus, true> = {
		open: true,
		working: true,
		delegated: true,
		done: true,
		dropped: true,
	}

	test("defaults execution units to open", () => {
		const task = Schema.decodeUnknownSync(TaskFrontmatter)({
			ticketUrl: "https://example.com/task",
			repo: "agency",
			branch: "task/default-status",
			base: "main",
			pr: null,
		})
		const phase = Schema.decodeUnknownSync(PhaseFrontmatter)({
			repo: "agency",
			branch: "task/default-phase-status",
			base: "main",
			pr: null,
		})

		expect("status" in task && task.status).toBe("open")
		expect(phase.status).toBe("open")
	})

	test("accepts every supported status on tasks and phases", () => {
		for (const status of Object.keys(supportedStatuses) as WorkStatus[]) {
			expect(Schema.decodeUnknownSync(WorkStatus)(status)).toBe(status)

			const task = Schema.decodeUnknownSync(TaskFrontmatter)({
				ticketUrl: null,
				repo: "agency",
				branch: `task/${status}`,
				base: "main",
				pr: null,
				status,
			})
			const phase = Schema.decodeUnknownSync(PhaseFrontmatter)({
				repo: "agency",
				branch: `phase/${status}`,
				base: "main",
				pr: null,
				status,
			})

			expect("status" in task && task.status).toBe(status)
			expect(phase.status).toBe(status)
		}
	})

	test("rejects unsupported statuses on tasks and phases", () => {
		expect(() => Schema.decodeUnknownSync(WorkStatus)("blocked")).toThrow()
		expect(() =>
			Schema.decodeUnknownSync(TaskFrontmatter)({
				ticketUrl: null,
				repo: "agency",
				branch: "task/invalid",
				base: "main",
				pr: null,
				status: "blocked",
			}),
		).toThrow()
		expect(() =>
			Schema.decodeUnknownSync(PhaseFrontmatter)({
				repo: "agency",
				branch: "phase/invalid",
				base: "main",
				pr: null,
				status: "blocked",
			}),
		).toThrow()
	})
})

describe("claim records", () => {
	const record = {
		claimant: "orchestrator",
		runner: "agent",
		sessionId: "job-1",
		startedAt: "2026-07-17T12:00:00.000Z",
		targetRevision: "0".repeat(64),
		expiresAt: "2026-07-17T13:00:00.000Z",
		state: "active" as const,
	}

	test("accepts explicit ownership and revision metadata", () => {
		expect(Schema.decodeUnknownSync(ClaimRecord)(record)).toEqual(record)
	})

	test("rejects malformed timestamps, revisions, and empty identities", () => {
		for (const invalid of [
			{ ...record, claimant: "" },
			{ ...record, startedAt: "today" },
			{ ...record, targetRevision: "abc" },
		]) {
			expect(() => Schema.decodeUnknownSync(ClaimRecord)(invalid)).toThrow()
		}
	})
})

describe("workbase registry", () => {
	test("accepts registered paths", () => {
		expect(
			Schema.decodeUnknownSync(WorkbaseRegistry)({
				version: 2,
				workbases: [
					{ id: "wb-one", name: "one", path: "/work/one" },
					{ id: "wb-two", path: "/work/two" },
				],
				defaultId: "wb-one",
			}),
		).toEqual({
			version: 2,
			workbases: [
				{ id: "wb-one", name: "one", path: "/work/one" },
				{ id: "wb-two", path: "/work/two" },
			],
			defaultId: "wb-one",
		})
	})

	test("rejects invalid versions and empty paths", () => {
		expect(() =>
			Schema.decodeUnknownSync(WorkbaseRegistry)({
				version: 3,
				workbases: [],
			}),
		).toThrow()
		expect(() =>
			Schema.decodeUnknownSync(WorkbaseRegistry)({
				version: 2,
				workbases: [{ id: "wb-one", path: "" }],
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

	test("accepts a configured chooser argv", () => {
		expect(
			Schema.decodeUnknownSync(WorkbaseConfig)({
				version: 2,
				chooserCommand: ["fzf", "--accept-nth=1"],
			}),
		).toEqual({
			version: 2,
			chooserCommand: ["fzf", "--accept-nth=1"],
		})
	})
})
