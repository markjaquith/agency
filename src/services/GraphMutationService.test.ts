import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { Effect } from "effect"
import { cleanupTempDir, createTempDir, runTestEffect } from "../test-utils"
import { EpicService } from "./EpicService"
import { GraphMutationService } from "./GraphMutationService"
import { PhaseService } from "./PhaseService"
import { TaskService } from "./TaskService"
import {
	formatMarkdownDocument,
	parseFrontmatter,
} from "../workbase/frontmatter"

describe("GraphMutationService", () => {
	let root: string

	beforeEach(async () => {
		root = await createTempDir()
		await Bun.write(join(root, "agency.json"), '{"version":2}\n')
		await mkdir(join(root, "repos/agency"), { recursive: true })
		await mkdir(join(root, "repos/docs"), { recursive: true })
		await runTestEffect(
			Effect.gen(function* () {
				const epics = yield* EpicService
				const tasks = yield* TaskService
				const phases = yield* PhaseService
				yield* epics.create(
					"first-epic",
					"https://example.com/first",
					[{ repo: "agency", ref: "main" }],
					root,
				)
				yield* epics.create(
					"second-epic",
					"https://example.com/second",
					[{ repo: "agency", ref: "main" }],
					root,
				)
				for (const id of ["alpha", "beta", "gamma"]) {
					yield* tasks.create(
						{
							id,
							ticketUrl: null,
							epic: "first-epic",
							repo: "agency",
							branch: `task/${id}`,
							base: "main",
						},
						root,
					)
				}
				yield* tasks.create(
					{
						id: "multi",
						ticketUrl: "https://example.com/multi",
						multiPhase: true,
					},
					root,
				)
				yield* phases.create(
					{
						taskId: "multi",
						id: "build",
						repo: "agency",
						branch: "task/multi-build",
						base: "main",
					},
					root,
				)
				yield* phases.create(
					{
						taskId: "multi",
						id: "ship",
						repo: "agency",
						branch: "task/multi-ship",
						base: "main",
					},
					root,
				)
			}),
		)
	})

	afterEach(async () => cleanupTempDir(root))

	test("updates descriptions, tickets, repositories, and execution metadata", async () => {
		const output = await runTestEffect(
			Effect.gen(function* () {
				const mutations = yield* GraphMutationService
				yield* mutations.updateEpic(
					"first-epic",
					{
						description: "Updated epic",
						ticketUrl: "https://example.com/revised",
						repos: [{ repo: "docs", ref: "trunk" }],
					},
					root,
				)
				yield* mutations.updateTask(
					"alpha",
					{
						description: "Updated task",
						ticketUrl: "https://example.com/alpha",
						repos: [{ repo: "docs", ref: "main" }],
						branch: "feature/alpha",
						base: "develop",
						pr: "https://github.com/example/agency/pull/12",
					},
					root,
				)
				return yield* mutations.updatePhase(
					"multi",
					"build",
					{
						description: "Updated phase",
						repo: "docs",
						branch: "feature/build",
						base: "develop",
					},
					root,
				)
			}),
		)

		expect(output).toMatchObject({
			operation: "phase.update",
			changed: true,
			validation: { valid: true },
		})
		await runTestEffect(
			Effect.gen(function* () {
				const epics = yield* EpicService
				const tasks = yield* TaskService
				const phases = yield* PhaseService
				expect((yield* epics.show("first-epic", root)).data).toMatchObject({
					description: "Updated epic",
					ticketUrl: "https://example.com/revised",
					repos: [{ repo: "docs", ref: "trunk" }],
				})
				expect((yield* tasks.show("alpha", root)).data).toMatchObject({
					description: "Updated task",
					ticketUrl: "https://example.com/alpha",
					repos: [{ repo: "docs", ref: "main" }],
					branch: "feature/alpha",
					base: "develop",
					pr: "https://github.com/example/agency/pull/12",
				})
				expect((yield* phases.show("multi", "build", root)).data).toMatchObject(
					{
						description: "Updated phase",
						repo: "docs",
						branch: "feature/build",
						base: "develop",
					},
				)
			}),
		)
	})

	test("preserves dependency order and rejects cycles", async () => {
		await runTestEffect(
			Effect.gen(function* () {
				const mutations = yield* GraphMutationService
				yield* mutations.mutateTaskDependency("add", "beta", "alpha", root)
				yield* mutations.mutateTaskDependency("add", "beta", "gamma", root)
				yield* mutations.mutateTaskDependency("remove", "beta", "alpha", root)
				yield* mutations.mutatePhaseDependency(
					"add",
					"multi",
					"ship",
					"build",
					root,
				)
			}),
		)
		await expect(
			runTestEffect(
				Effect.gen(function* () {
					return yield* (yield* GraphMutationService).mutateTaskDependency(
						"add",
						"gamma",
						"beta",
						root,
					)
				}),
			),
		).rejects.toThrow("dependency cycle")

		await expect(
			runTestEffect(
				Effect.gen(function* () {
					return yield* (yield* GraphMutationService).mutateTaskDependency(
						"add",
						"beta",
						"gamma",
						root,
					)
				}),
			),
		).rejects.toThrow("already depends")

		await runTestEffect(
			Effect.gen(function* () {
				const epics = yield* EpicService
				const tasks = yield* TaskService
				const declarations = (yield* epics.show("first-epic", root)).data.tasks
				expect(
					declarations.find((item) => item.id === "beta")?.dependsOn,
				).toEqual(["gamma"])
				expect((yield* tasks.show("multi", root)).data).toMatchObject({
					phases: [{ id: "build" }, { id: "ship", dependsOn: ["build"] }],
				})
			}),
		)
	})

	test("renames entities and rewrites every structured reference", async () => {
		await runTestEffect(
			Effect.gen(function* () {
				const mutations = yield* GraphMutationService
				yield* mutations.mutateTaskDependency("add", "beta", "alpha", root)
				yield* mutations.mutatePhaseDependency(
					"add",
					"multi",
					"ship",
					"build",
					root,
				)
				yield* mutations.renameTask("alpha", "renamed-alpha", root)
				yield* mutations.renamePhase("multi", "build", "compile", root)
				yield* mutations.renameEpic("first-epic", "renamed-epic", root)
			}),
		)

		await runTestEffect(
			Effect.gen(function* () {
				const epics = yield* EpicService
				const tasks = yield* TaskService
				const phases = yield* PhaseService
				const epic = yield* epics.show("renamed-epic", root)
				expect(
					epic.data.tasks.find((item) => item.id === "beta")?.dependsOn,
				).toEqual(["renamed-alpha"])
				expect((yield* tasks.show("renamed-alpha", root)).data.epic).toBe(
					"renamed-epic",
				)
				expect((yield* tasks.show("multi", root)).data).toMatchObject({
					phases: [{ id: "compile" }, { id: "ship", dependsOn: ["compile"] }],
				})
				expect((yield* phases.show("multi", "compile", root)).id).toBe(
					"compile",
				)
			}),
		)
	})

	test("moves task membership in both directions", async () => {
		await runTestEffect(
			Effect.gen(function* () {
				yield* (yield* GraphMutationService).moveTask(
					"alpha",
					"second-epic",
					root,
				)
				const epics = yield* EpicService
				const tasks = yield* TaskService
				expect(
					(yield* epics.show("first-epic", root)).data.tasks.map(
						(item) => item.id,
					),
				).not.toContain("alpha")
				expect(
					(yield* epics.show("second-epic", root)).data.tasks.map(
						(item) => item.id,
					),
				).toEqual(["alpha"])
				expect((yield* tasks.show("alpha", root)).data.epic).toBe("second-epic")
			}),
		)
	})

	test("refuses a rename that would invalidate a materialized worktree", async () => {
		await mkdir(join(root, "tasks/alpha/code/agency"), { recursive: true })
		await expect(
			runTestEffect(
				Effect.gen(function* () {
					return yield* (yield* GraphMutationService).renameTask(
						"alpha",
						"renamed-alpha",
						root,
					)
				}),
			),
		).rejects.toThrow("materialized worktree")
		expect(await Bun.file(join(root, "tasks/alpha/TASK.md")).exists()).toBe(
			true,
		)
		expect(
			await Bun.file(join(root, "tasks/renamed-alpha/TASK.md")).exists(),
		).toBe(false)
	})

	test("refuses rename when the parent backlink is inconsistent", async () => {
		await runTestEffect(
			Effect.gen(function* () {
				const epic = yield* (yield* EpicService).show("first-epic", root)
				const parsed = yield* parseFrontmatter(epic.content, epic.path)
				yield* Effect.promise(() =>
					Bun.write(
						epic.path,
						formatMarkdownDocument(
							{
								...epic.data,
								tasks: epic.data.tasks.filter((item) => item.id !== "alpha"),
							},
							parsed.body,
						),
					),
				)
			}),
		)

		await expect(
			runTestEffect(
				Effect.gen(function* () {
					return yield* (yield* GraphMutationService).renameTask(
						"alpha",
						"renamed-alpha",
						root,
					)
				}),
			),
		).rejects.toThrow("parent epic 'first-epic' does not list it")
	})
})
