import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { cleanupTempDir, createTempDir, runTestEffect } from "../test-utils"
import { EpicService } from "./EpicService"
import { TaskService } from "./TaskService"
import { PhaseService } from "./PhaseService"
import { PullRequestService } from "./PullRequestService"

describe("task and phase services", () => {
	let root: string

	beforeEach(async () => {
		root = await createTempDir()
		await Bun.write(join(root, "agency.json"), '{"version":2}\n')
		await mkdir(join(root, "repos/agency"), { recursive: true })
		await mkdir(join(root, "repos/effect"), { recursive: true })
	})

	afterEach(async () => cleanupTempDir(root))

	test("creates a single-phase task and updates its epic", async () => {
		await runTestEffect(
			EpicService.pipe(
				Effect.flatMap((service) =>
					service.create(
						"example",
						"https://example.com/epic",
						[{ repo: "agency", ref: "main" }],
						root,
					),
				),
			),
		)
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "task-one",
							ticketUrl: "https://example.com/task",
							epic: "example",
							repo: "agency",
							repos: [{ repo: "effect", ref: "main" }],
							branch: "task/one",
							base: "main",
						},
						root,
					),
				),
			),
		)

		const epic = await runTestEffect(
			EpicService.pipe(
				Effect.flatMap((service) => service.show("example", root)),
			),
		)
		expect(epic.data.tasks).toEqual([{ id: "task-one" }])
	})

	test("does not create a task when its parent update cannot start", async () => {
		await runTestEffect(
			EpicService.pipe(
				Effect.flatMap((service) =>
					service.create(
						"locked",
						"https://example.com/epic",
						[{ repo: "agency", ref: "main" }],
						root,
					),
				),
			),
		)
		const lock = join(root, ".agency-graph-mutation.lock")
		await Bun.write(lock, "held")
		await expect(
			runTestEffect(
				TaskService.pipe(
					Effect.flatMap((service) =>
						service.create(
							{
								id: "not-created",
								ticketUrl: null,
								epic: "locked",
								repo: "agency",
								branch: "task/not-created",
								base: "main",
							},
							root,
						),
					),
				),
			),
		).rejects.toThrow("Another graph mutation is in progress")
		await rm(lock)
		expect(
			await Bun.file(join(root, "tasks/not-created/TASK.md")).exists(),
		).toBe(false)
		const epic = await runTestEffect(
			EpicService.pipe(
				Effect.flatMap((service) => service.show("locked", root)),
			),
		)
		expect(epic.data.tasks).toEqual([])
	})

	test("creates and sequences phases on a multi-phase task", async () => {
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "multi",
							ticketUrl: "https://example.com/task",
							multiPhase: true,
						},
						root,
					),
				),
			),
		)
		for (const phase of [
			{ id: "first", dependsOn: undefined },
			{ id: "second", dependsOn: ["first"] },
		]) {
			await runTestEffect(
				PhaseService.pipe(
					Effect.flatMap((service) =>
						service.create(
							{
								taskId: "multi",
								id: phase.id,
								repo: "agency",
								branch: `task/${phase.id}`,
								base: "main",
								dependsOn: phase.dependsOn,
							},
							root,
						),
					),
				),
			)
		}

		const task = await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) => service.show("multi", root)),
			),
		)
		expect("phases" in task.data && task.data.phases).toEqual([
			{ id: "first" },
			{ id: "second", dependsOn: ["first"] },
		])
		const phases = await runTestEffect(
			PhaseService.pipe(
				Effect.flatMap((service) => service.list("multi", root)),
			),
		)
		expect(phases.map((phase) => phase.id)).toEqual(["first", "second"])
	})

	test("converts a single-phase task when the existing phase ID is provided", async () => {
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "single",
							ticketUrl: "https://example.com/task",
							description: "Deliver the complete task.",
							repo: "agency",
							repos: [{ repo: "effect", ref: "main" }],
							branch: "task/single",
							base: "main",
						},
						root,
					),
				),
			),
		)
		await runTestEffect(
			PullRequestService.pipe(
				Effect.flatMap((service) =>
					service.setUrl(
						"single",
						undefined,
						"https://github.com/example/agency/pull/42",
						root,
					),
				),
			),
		)
		await expect(
			runTestEffect(
				PhaseService.pipe(
					Effect.flatMap((service) =>
						service.create(
							{
								taskId: "single",
								id: "extra",
								repo: "agency",
								branch: "task/extra",
								base: "main",
							},
							root,
						),
					),
				),
			),
		).rejects.toThrow("requires --first-phase")

		await runTestEffect(
			PhaseService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							taskId: "single",
							id: "extra",
							firstPhase: "implementation",
							repo: "agency",
							branch: "task/extra",
							base: "main",
							dependsOn: ["implementation"],
						},
						root,
					),
				),
			),
		)

		const task = await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) => service.show("single", root)),
			),
		)
		expect(task.data).toEqual({
			ticketUrl: "https://example.com/task",
			description: "Deliver the complete task.",
			phases: [
				{ id: "implementation" },
				{ id: "extra", dependsOn: ["implementation"] },
			],
		})
		expect(task.content).toContain("Describe the task outcome.")

		const firstPhase = await runTestEffect(
			PhaseService.pipe(
				Effect.flatMap((service) =>
					service.show("single", "implementation", root),
				),
			),
		)
		expect(firstPhase.data).toEqual({
			repo: "agency",
			repos: [{ repo: "effect", ref: "main" }],
			branch: "task/single",
			base: "main",
			pr: {
				provider: "github",
				repository: "example/agency",
				identifier: "42",
				url: "https://github.com/example/agency/pull/42",
				state: "open",
				draft: false,
				merged: false,
			},
			status: "open",
		})
	})

	test("updates status on execution units", async () => {
		const createdTask = await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "single-status",
							ticketUrl: "https://example.com/task",
							repo: "agency",
							branch: "task/single-status",
							base: "main",
						},
						root,
					),
				),
			),
		)
		expect(createdTask.content).toContain("status: open")
		const workingTask = await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.setStatus("single-status", "working", root),
				),
			),
		)
		expect(workingTask.data.status).toBe("working")
		await expect(
			runTestEffect(
				TaskService.pipe(
					Effect.flatMap((service) =>
						service.setStatus("single-status", "delegated", root),
					),
				),
			),
		).rejects.toThrow("Delegation requires explicit ownership")
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.setStatus("single-status", "done", root),
				),
			),
		)
		await expect(
			runTestEffect(
				TaskService.pipe(
					Effect.flatMap((service) =>
						service.setStatus("single-status", "dropped", root),
					),
				),
			),
		).rejects.toThrow("reopen it first")

		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "multi-status",
							ticketUrl: "https://example.com/task",
							multiPhase: true,
						},
						root,
					),
				),
			),
		)
		await runTestEffect(
			PhaseService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							taskId: "multi-status",
							id: "implementation",
							repo: "agency",
							branch: "task/multi-status",
							base: "main",
						},
						root,
					),
				),
			),
		)
		const workingPhase = await runTestEffect(
			PhaseService.pipe(
				Effect.flatMap((service) =>
					service.setStatus("multi-status", "implementation", "working", root),
				),
			),
		)
		expect(workingPhase.data.status).toBe("working")
		const phase = await runTestEffect(
			PhaseService.pipe(
				Effect.flatMap((service) =>
					service.setStatus("multi-status", "implementation", "dropped", root),
				),
			),
		)
		expect(phase.data.status).toBe("dropped")
		await expect(
			runTestEffect(
				PhaseService.pipe(
					Effect.flatMap((service) =>
						service.setStatus("multi-status", "implementation", "done", root),
					),
				),
			),
		).rejects.toThrow("reopen it first")
		await runTestEffect(
			PhaseService.pipe(
				Effect.flatMap((service) =>
					service.setStatus("multi-status", "implementation", "open", root),
				),
			),
		)
		expect(
			(
				await runTestEffect(
					PhaseService.pipe(
						Effect.flatMap((service) =>
							service.setStatus("multi-status", "implementation", "done", root),
						),
					),
				)
			).data.status,
		).toBe("done")
		await expect(
			runTestEffect(
				TaskService.pipe(
					Effect.flatMap((service) =>
						service.setStatus("multi-status", "done", root),
					),
				),
			),
		).rejects.toThrow("set status on a phase instead")
	})
})
