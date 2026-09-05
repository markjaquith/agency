import { describe, expect, test } from "bun:test"
import { Schema } from "@effect/schema"
import {
	EntityId,
	EpicFrontmatter,
	PhaseFrontmatter,
	TaskFrontmatter,
	WorkStatus,
	WorkbaseConfig,
	WorkbaseRegistry,
	RepositoryRemote,
} from "./schemas"

describe("portable repository declarations", () => {
	test("accepts provider-neutral network Git remotes", () => {
		for (const remote of [
			"https://example.com/team/repository.git",
			"ssh://git@example.com/team/repository.git",
			"git://example.com/team/repository.git",
			"git@example.com:team/repository.git",
			"ssh://[2001:db8::1]/team/repository.git",
		]) {
			expect(Schema.decodeUnknownSync(RepositoryRemote)(remote)).toBe(remote)
		}
	})

	test("rejects local paths, unsupported protocols, and credential-bearing URLs", () => {
		for (const remote of [
			"/Users/person/repository.git",
			"../repository.git",
			"file:///tmp/repository.git",
			"https://token@example.com/team/repository.git",
			"https://user:password@example.com/team/repository.git",
			"ssh://user:password@example.com/team/repository.git",
			"ftp://example.com/team/repository.git",
			"custom://example.com/team/repository.git",
			"C:/repository.git",
			"https://example.com/repository.git?token=secret",
			"ext::printf",
			"foo::bar",
			"-host:repository.git",
			"-oProxyCommand=x@host:repository.git",
		]) {
			expect(() => Schema.decodeUnknownSync(RepositoryRemote)(remote)).toThrow()
		}
	})

	test("decodes repository declarations in version 2 configs", () => {
		expect(
			Schema.decodeUnknownSync(WorkbaseConfig)({
				version: 2,
				repositories: {
					agency: { remote: "https://example.com/agency.git" },
				},
			}),
		).toEqual({
			version: 2,
			repositories: {
				agency: { remote: "https://example.com/agency.git" },
			},
		})
	})
})

describe("body-of-work descriptions", () => {
	test("decodes strict task purpose and handoff provenance", () => {
		const handoff = {
			source: { kind: "phase", taskId: "investigate", phaseId: "evidence" },
			sourceRevision: "a".repeat(64),
		}
		const task = Schema.decodeUnknownSync(TaskFrontmatter, {
			onExcessProperty: "error",
		})({
			ticketUrl: null,
			purpose: "implementation",
			handoff,
			repo: "agency",
			branch: "task/implement",
			base: "main",
			pr: null,
		})
		expect(task).toMatchObject({ purpose: "implementation", handoff })

		for (const invalid of [
			{ ...handoff, sourceRevision: "short" },
			{ ...handoff, source: { kind: "phase", taskId: "investigate" } },
			{ ...handoff, source: { kind: "task", taskId: "../unsafe" } },
		]) {
			expect(() =>
				Schema.decodeUnknownSync(TaskFrontmatter, {
					onExcessProperty: "error",
				})({
					ticketUrl: null,
					purpose: "implementation",
					handoff: invalid,
					phases: [],
				}),
			).toThrow()
		}
	})

	test("decodes review tasks strictly and rejects writable execution fields", () => {
		const review = {
			ticketUrl: null,
			review: {
				repo: "agency",
				source: { kind: "branch", ref: "refs/heads/feature/review" },
				commit: "a".repeat(40),
				refreshedAt: "2026-07-23T12:00:00.000Z",
			},
		}
		expect(
			Schema.decodeUnknownSync(TaskFrontmatter, { onExcessProperty: "error" })(
				review,
			),
		).toMatchObject({ status: "open", review: review.review })
		for (const field of ["repo", "repos", "branch", "base", "pr"]) {
			expect(() =>
				Schema.decodeUnknownSync(TaskFrontmatter, {
					onExcessProperty: "error",
				})({ ...review, [field]: field === "repos" ? [] : "forbidden" }),
			).toThrow()
		}
	})

	test("rejects inconsistent pull request source provenance", () => {
		const source = {
			kind: "pull-request",
			provider: "github",
			repository: "owner/repo",
			identifier: "42",
			url: "https://github.com/owner/repo/pull/42",
			fetchRef: "refs/pull/42/head",
		}
		const review = {
			ticketUrl: null,
			review: {
				repo: "agency",
				source,
				commit: "a".repeat(40),
				refreshedAt: "2026-07-23T12:00:00.000Z",
			},
		}
		expect(Schema.decodeUnknownSync(TaskFrontmatter)(review)).toBeDefined()
		for (const inconsistent of [
			{ ...source, url: "https://github.com/owner/repo/pull/41" },
			{ ...source, repository: "other/repo" },
			{ ...source, fetchRef: "refs/pull/41/head" },
		]) {
			expect(() =>
				Schema.decodeUnknownSync(TaskFrontmatter)({
					...review,
					review: { ...review.review, source: inconsistent },
				}),
			).toThrow()
		}
	})

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

describe("repository post-checkout configuration", () => {
	test("accepts a per-repository argv command", () => {
		const config = Schema.decodeUnknownSync(WorkbaseConfig)({
			version: 2,
			repositories: {
				agency: {
					remote: "https://example.com/agency.git",
					postCheckoutCommand: ["bun", "install", "--frozen-lockfile"],
				},
			},
		})

		expect(config.repositories?.agency?.postCheckoutCommand).toEqual([
			"bun",
			"install",
			"--frozen-lockfile",
		])
	})

	test("rejects shell strings in place of argv arrays", () => {
		expect(() =>
			Schema.decodeUnknownSync(WorkbaseConfig)({
				version: 2,
				repositories: {
					agency: {
						remote: "https://example.com/agency.git",
						postCheckoutCommand: "bun install",
					},
				},
			}),
		).toThrow()
	})
})

describe("agent configuration", () => {
	test("accepts named argv commands with resume commands and environment", () => {
		const config = Schema.decodeUnknownSync(WorkbaseConfig)({
			version: 2,
			agents: {
				custom: {
					command: ["agent"],
					autoCommand: ["agent", "{prompt}"],
					resumeCommand: ["agent", "resume", "{sessionId}"],
					autoResumeCommand: ["agent", "resume", "{sessionId}", "{prompt}"],
					environment: { CUSTOM_TARGET: "{target}" },
				},
			},
		})

		expect(config.agents?.custom?.autoCommand).toEqual(["agent", "{prompt}"])
	})

	test("rejects shell strings in place of argv arrays", () => {
		expect(() =>
			Schema.decodeUnknownSync(WorkbaseConfig)({
				version: 2,
				agents: { custom: { command: "agent {prompt}" } },
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
				mergeable: false,
			},
		})
		expect(phase.pr && typeof phase.pr !== "string" && phase.pr.provider).toBe(
			"forge",
		)
		expect(phase.pr && typeof phase.pr !== "string" && phase.pr.mergeable).toBe(
			false,
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

test("rejects removed claim frontmatter", () => {
	expect(() =>
		Schema.decodeUnknownSync(TaskFrontmatter, { onExcessProperty: "error" })({
			ticketUrl: null,
			repo: "agency",
			branch: "task/example",
			base: "main",
			pr: null,
			status: "working",
			claim: { state: "active" },
		}),
	).toThrow()
})

test("rejects impossible and non-canonical timestamps", () => {
	const task = {
		ticketUrl: null,
		repo: "agency",
		branch: "task/example",
		base: "main",
		pr: null,
		status: "done",
		completion: {
			mode: "non-pr",
			completedAt: "2026-07-17T12:00:00.000Z",
			summary: "Completed work",
		},
	}

	for (const completedAt of [
		"2026-99-99T99:99:99.000Z",
		"2026-07-17T12:00:00Z",
		"2026-02-29T13:00:00.000Z",
	]) {
		expect(() =>
			Schema.decodeUnknownSync(TaskFrontmatter)({
				...task,
				completion: { ...task.completion, completedAt },
			}),
		).toThrow()
	}
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
