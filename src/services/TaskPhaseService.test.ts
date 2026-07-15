import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { cleanupTempDir, createTempDir, runTestEffect } from "../test-utils"
import { EpicService } from "./EpicService"
import { TaskService } from "./TaskService"
import { PhaseService } from "./PhaseService"

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
						["agency"],
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
							repos: ["effect"],
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

	test("does not implicitly convert a single-phase task", async () => {
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "single",
							ticketUrl: "https://example.com/task",
							repo: "agency",
							branch: "task/single",
							base: "main",
						},
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
		).rejects.toThrow("conversion is not implemented")
	})
})
