import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { chmod, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { cleanupTempDir, createTempDir, runTestEffect } from "../test-utils"
import { ArchiveService } from "./ArchiveService"
import { EpicService } from "./EpicService"
import { GraphMutationService } from "./GraphMutationService"
import { PhaseService } from "./PhaseService"
import { TaskService } from "./TaskService"
import { WorktreeService } from "./WorktreeService"

const git = (args: readonly string[], cwd?: string) => {
	const result = Bun.spawnSync(["git", ...args], { cwd })
	if (result.exitCode !== 0) {
		throw new Error(new TextDecoder().decode(result.stderr))
	}
}

describe("ArchiveService bulk task archive", () => {
	let root: string
	let source: string

	beforeEach(async () => {
		root = await createTempDir()
		await Bun.write(join(root, "agency.json"), '{"version":2}\n')
		source = join(root, "source")
		await mkdir(source, { recursive: true })
		git(["init", "--initial-branch=main"], source)
		git(["config", "user.email", "test@example.com"], source)
		git(["config", "user.name", "Test"], source)
		await Bun.write(join(source, "README.md"), "example\n")
		git(["add", "README.md"], source)
		git(["-c", "commit.gpgsign=false", "commit", "-m", "initial"], source)
		await mkdir(join(root, "repos"), { recursive: true })
		git(["clone", "--bare", source, join(root, "repos/agency")])
	})

	afterEach(async () => cleanupTempDir(root))

	const createTask = (id: string, epic?: string) =>
		runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id,
							ticketUrl: null,
							...(epic ? { epic } : {}),
							repo: "agency",
							branch: `task/${id}`,
							base: "main",
						},
						root,
					),
				),
			),
		)

	const dropTask = (id: string) =>
		runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) => service.setStatus(id, "dropped", root)),
			),
		)

	const archiveTasks = (dryRun = false) =>
		runTestEffect(
			ArchiveService.pipe(
				Effect.flatMap((service) => service.archiveTasks(root, { dryRun })),
			),
		)

	test("returns sorted dispositions and treats an empty multi-phase task as non-terminal", async () => {
		await createTask("z-dropped")
		await dropTask("z-dropped")
		await createTask("a-open")
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{ id: "m-empty", ticketUrl: null, multiPhase: true },
						root,
					),
				),
			),
		)

		const result = await archiveTasks(true)

		expect(result.tasks.map((task) => task.id)).toEqual([
			"a-open",
			"m-empty",
			"z-dropped",
		])
		expect(result.tasks).toMatchObject([
			{
				id: "a-open",
				disposition: "skipped",
				reason: { code: "non-terminal", details: ["status=open"] },
			},
			{
				id: "m-empty",
				disposition: "skipped",
				reason: {
					code: "non-terminal",
					details: ["multi-phase task has no phases"],
				},
			},
			{ id: "z-dropped", disposition: "planned" },
		])
		expect(await Bun.file(join(root, "tasks/z-dropped/TASK.md")).exists()).toBe(
			true,
		)
	})

	test("reuses loaded records while preflighting task worktrees", async () => {
		for (const id of ["first", "second"]) {
			await createTask(id)
			await dropTask(id)
		}
		let taskReads = 0
		const file = Bun.file(join(root, "tasks/first/TASK.md"))
		const prototype = Object.getPrototypeOf(file) as {
			text: () => Promise<string>
			name: string
		}
		const originalText = prototype.text
		prototype.text = function () {
			if (this.name.endsWith("/TASK.md")) taskReads += 1
			return originalText.call(this)
		}

		try {
			const result = await archiveTasks(true)
			expect(result.tasks.map((task) => task.disposition)).toEqual([
				"planned",
				"planned",
			])
			expect(taskReads).toBe(10)
		} finally {
			prototype.text = originalText
		}
	})

	test("uses aggregate phase status and archives only when every phase is terminal", async () => {
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{ id: "multi", ticketUrl: null, multiPhase: true },
						root,
					),
				),
			),
		)
		for (const id of ["done", "open"]) {
			await runTestEffect(
				PhaseService.pipe(
					Effect.flatMap((service) =>
						service.create(
							{
								taskId: "multi",
								id,
								repo: "agency",
								branch: `task/multi-${id}`,
								base: "main",
							},
							root,
						),
					),
				),
			)
		}
		await runTestEffect(
			PhaseService.pipe(
				Effect.flatMap((service) =>
					service.setStatus("multi", "done", "dropped", root),
				),
			),
		)

		const mixed = await archiveTasks(true)
		expect(mixed.tasks[0]).toMatchObject({
			disposition: "skipped",
			reason: { code: "non-terminal" },
		})

		await runTestEffect(
			PhaseService.pipe(
				Effect.flatMap((service) =>
					service.setStatus("multi", "open", "dropped", root),
				),
			),
		)
		const terminal = await archiveTasks()
		expect(terminal.tasks[0]).toMatchObject({
			id: "multi",
			disposition: "archived",
		})
		expect(
			await Bun.file(join(root, "archive/tasks/multi/TASK.md")).exists(),
		).toBe(true)
	})

	test("propagates retained-dependent skips to a fixed point", async () => {
		await runTestEffect(
			EpicService.pipe(
				Effect.flatMap((service) =>
					service.create(
						"parent",
						"https://example.com/epic",
						[{ repo: "agency", ref: "main" }],
						root,
					),
				),
			),
		)
		for (const id of ["base", "middle", "retained"])
			await createTask(id, "parent")
		await runTestEffect(
			GraphMutationService.pipe(
				Effect.flatMap((service) =>
					service.mutateTaskDependency("add", "middle", "base", root),
				),
			),
		)
		await runTestEffect(
			GraphMutationService.pipe(
				Effect.flatMap((service) =>
					service.mutateTaskDependency("add", "retained", "middle", root),
				),
			),
		)
		await dropTask("base")
		await dropTask("middle")

		const result = await archiveTasks()

		expect(result.tasks).toMatchObject([
			{
				id: "base",
				disposition: "skipped",
				reason: { code: "retained-dependent", details: ["middle"] },
			},
			{
				id: "middle",
				disposition: "skipped",
				reason: { code: "retained-dependent", details: ["retained"] },
			},
			{
				id: "retained",
				disposition: "skipped",
				reason: { code: "non-terminal" },
			},
		])
	})

	test("archives an internal dependency cohort and updates its parent once without archiving it", async () => {
		await runTestEffect(
			EpicService.pipe(
				Effect.flatMap((service) =>
					service.create(
						"parent",
						"https://example.com/epic",
						[{ repo: "agency", ref: "main" }],
						root,
					),
				),
			),
		)
		await createTask("base", "parent")
		await createTask("dependent", "parent")
		await runTestEffect(
			GraphMutationService.pipe(
				Effect.flatMap((service) =>
					service.mutateTaskDependency("add", "dependent", "base", root),
				),
			),
		)
		await dropTask("base")
		await dropTask("dependent")

		const result = await archiveTasks()

		expect(result.tasks.map((task) => task.disposition)).toEqual([
			"archived",
			"archived",
		])
		const parent = await runTestEffect(
			EpicService.pipe(
				Effect.flatMap((service) => service.show("parent", root)),
			),
		)
		expect(parent.data.tasks).toEqual([])
		expect(await Bun.file(join(root, "epics/parent/EPIC.md")).exists()).toBe(
			true,
		)
		expect(await Bun.file(join(root, "archive/epics/parent")).exists()).toBe(
			false,
		)
	})

	test("skips destination collisions and dirty managed worktrees", async () => {
		await createTask("collision")
		await dropTask("collision")
		await mkdir(join(root, "archive/tasks/collision"), { recursive: true })
		await createTask("dirty")
		await dropTask("dirty")
		const workspace = await runTestEffect(
			WorktreeService.pipe(
				Effect.flatMap((service) =>
					service.materialize("dirty", undefined, root),
				),
			),
		)
		await Bun.write(join(workspace.writablePath!, "dirty.txt"), "keep\n")

		const result = await archiveTasks()

		expect(result.tasks).toMatchObject([
			{
				id: "collision",
				disposition: "skipped",
				reason: { code: "destination-exists" },
			},
			{
				id: "dirty",
				disposition: "skipped",
				reason: { code: "dirty-worktree" },
			},
		])
		expect(
			await Bun.file(join(workspace.writablePath!, "dirty.txt")).exists(),
		).toBe(true)
	})

	test("rolls back the entire cohort when application fails", async () => {
		await runTestEffect(
			EpicService.pipe(
				Effect.flatMap((service) =>
					service.create(
						"rollback-parent",
						"https://example.com/epic",
						[{ repo: "agency", ref: "main" }],
						root,
					),
				),
			),
		)
		for (const id of ["first", "second"]) {
			await createTask(id, "rollback-parent")
			await dropTask(id)
		}
		const archiveDirectory = join(root, "archive")
		await mkdir(archiveDirectory, { mode: 0o500 })

		try {
			await expect(archiveTasks()).rejects.toThrow("rolled back")
		} finally {
			await chmod(archiveDirectory, 0o700)
		}

		for (const id of ["first", "second"]) {
			expect(await Bun.file(join(root, `tasks/${id}/TASK.md`)).exists()).toBe(
				true,
			)
			expect(
				await Bun.file(
					join(root, `tasks/${id}/.agency-lifecycle.json`),
				).exists(),
			).toBe(false)
		}
		const parent = await runTestEffect(
			EpicService.pipe(
				Effect.flatMap((service) => service.show("rollback-parent", root)),
			),
		)
		expect(parent.data.tasks.map((task) => task.id)).toEqual([
			"first",
			"second",
		])
	})
})
