import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { cleanupTempDir, createTempDir, runTestEffect } from "../test-utils"
import { ArchiveService } from "./ArchiveService"
import { EpicService } from "./EpicService"
import { PhaseService } from "./PhaseService"
import { TaskService } from "./TaskService"
import { WorkbaseService } from "./WorkbaseService"
import { WorktreeService } from "./WorktreeService"

const git = async (args: string[], cwd?: string) => {
	const process = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	})
	await process.exited
	if (process.exitCode !== 0) {
		throw new Error(await new Response(process.stderr).text())
	}
}

describe("ArchiveService", () => {
	let root: string

	beforeEach(async () => {
		root = await createTempDir()
		await Bun.write(join(root, "agency.json"), '{"version":2}\n')
		const source = join(root, "source")
		await mkdir(source, { recursive: true })
		await git(["init", "--initial-branch=main"], source)
		await git(["config", "user.email", "test@example.com"], source)
		await git(["config", "user.name", "Test"], source)
		await Bun.write(join(source, "README.md"), "example\n")
		await git(["add", "README.md"], source)
		await git(["-c", "commit.gpgsign=false", "commit", "-m", "initial"], source)
		await mkdir(join(root, "repos"), { recursive: true })
		await git(["clone", "--bare", source, join(root, "repos/agency")])
	})

	afterEach(async () => cleanupTempDir(root))

	test("archives a task after removing its worktree and preserves its branch", async () => {
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
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "child",
							ticketUrl: "https://example.com/task",
							epic: "parent",
							repo: "agency",
							branch: "task/child",
							base: "main",
						},
						root,
					),
				),
			),
		)
		await runTestEffect(
			WorktreeService.pipe(
				Effect.flatMap((service) =>
					service.materialize("child", undefined, root),
				),
			),
		)

		const result = await runTestEffect(
			ArchiveService.pipe(
				Effect.flatMap((service) => service.archiveTask("child", root)),
			),
		)

		expect(result.path).toBe(join(root, "archive/tasks/child"))
		expect(await Bun.file(join(root, "tasks/child/TASK.md")).exists()).toBe(
			false,
		)
		expect(await Bun.file(join(result.path, "TASK.md")).exists()).toBe(true)
		expect(await Bun.file(join(result.path, "code")).exists()).toBe(false)
		const epic = await runTestEffect(
			EpicService.pipe(
				Effect.flatMap((service) => service.show("parent", root)),
			),
		)
		expect(epic.data.tasks).toEqual([])
		const report = await runTestEffect(
			WorkbaseService.pipe(Effect.flatMap((service) => service.validate(root))),
		)
		expect(report.valid).toBe(true)
		expect(
			Bun.spawnSync([
				"git",
				"-C",
				join(root, "repos/agency"),
				"show-ref",
				"--verify",
				"refs/heads/task/child",
			]).exitCode,
		).toBe(0)
	})

	test("archives a phase in the mirrored task hierarchy", async () => {
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
		for (const id of ["first", "second"]) {
			await runTestEffect(
				PhaseService.pipe(
					Effect.flatMap((service) =>
						service.create(
							{
								taskId: "multi",
								id,
								repo: "agency",
								branch: `task/${id}`,
								base: "main",
							},
							root,
						),
					),
				),
			)
		}
		await runTestEffect(
			WorktreeService.pipe(
				Effect.flatMap((service) =>
					service.materialize("multi", "second", root),
				),
			),
		)

		const result = await runTestEffect(
			ArchiveService.pipe(
				Effect.flatMap((service) =>
					service.archivePhase("multi", "second", root),
				),
			),
		)

		expect(result.path).toBe(join(root, "archive/tasks/multi/phases/second"))
		expect(await Bun.file(join(result.path, "PHASE.md")).exists()).toBe(true)
		expect(await Bun.file(join(result.path, "code")).exists()).toBe(false)
		const task = await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) => service.show("multi", root)),
			),
		)
		expect("phases" in task.data && task.data.phases).toEqual([{ id: "first" }])
		const report = await runTestEffect(
			WorkbaseService.pipe(Effect.flatMap((service) => service.validate(root))),
		)
		expect(report.valid).toBe(true)
	})

	test("archives an epic and all of its child task folders", async () => {
		await runTestEffect(
			EpicService.pipe(
				Effect.flatMap((service) =>
					service.create(
						"initiative",
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
							id: "delivery",
							ticketUrl: "https://example.com/task",
							epic: "initiative",
							repo: "agency",
							branch: "task/delivery",
							base: "main",
						},
						root,
					),
				),
			),
		)

		const result = await runTestEffect(
			ArchiveService.pipe(
				Effect.flatMap((service) => service.archiveEpic("initiative", root)),
			),
		)

		expect(result.affectedPaths).toEqual([
			join(root, "archive/tasks/delivery"),
			join(root, "archive/epics/initiative"),
		])
		expect(
			await Bun.file(join(root, "archive/epics/initiative/EPIC.md")).exists(),
		).toBe(true)
		expect(
			await Bun.file(join(root, "archive/tasks/delivery/TASK.md")).exists(),
		).toBe(true)
		const report = await runTestEffect(
			WorkbaseService.pipe(Effect.flatMap((service) => service.validate(root))),
		)
		expect(report.valid).toBe(true)
	})

	test("rejects archiving an item required by an active sibling", async () => {
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
		await runTestEffect(
			PhaseService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							taskId: "multi",
							id: "first",
							repo: "agency",
							branch: "task/first",
							base: "main",
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
							taskId: "multi",
							id: "second",
							repo: "agency",
							branch: "task/second",
							base: "main",
							dependsOn: ["first"],
						},
						root,
					),
				),
			),
		)

		await expect(
			runTestEffect(
				ArchiveService.pipe(
					Effect.flatMap((service) =>
						service.archivePhase("multi", "first", root),
					),
				),
			),
		).rejects.toThrow("phase 'second' depends on it")
	})

	test("does not move a task when its worktree is dirty", async () => {
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "dirty",
							ticketUrl: "https://example.com/task",
							repo: "agency",
							branch: "task/dirty",
							base: "main",
						},
						root,
					),
				),
			),
		)
		const workspace = await runTestEffect(
			WorktreeService.pipe(
				Effect.flatMap((service) =>
					service.materialize("dirty", undefined, root),
				),
			),
		)
		await Bun.write(join(workspace.writablePath, "dirty.txt"), "keep me\n")

		await expect(
			runTestEffect(
				ArchiveService.pipe(
					Effect.flatMap((service) => service.archiveTask("dirty", root)),
				),
			),
		).rejects.toThrow("Failed to remove worktree")
		expect(await Bun.file(join(root, "tasks/dirty/TASK.md")).exists()).toBe(
			true,
		)
		expect(await Bun.file(join(root, "archive/tasks/dirty")).exists()).toBe(
			false,
		)
	})

	test("dry-runs archive and restores without mutating files", async () => {
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "preview",
							ticketUrl: null,
							repo: "agency",
							branch: "task/preview",
							base: "main",
						},
						root,
					),
				),
			),
		)

		const archivePreview = await runTestEffect(
			ArchiveService.pipe(
				Effect.flatMap((service) =>
					service.archiveTask("preview", root, { dryRun: true }),
				),
			),
		)
		expect(archivePreview.dryRun).toBe(true)
		expect(await Bun.file(join(root, "tasks/preview/TASK.md")).exists()).toBe(
			true,
		)
		expect(
			await Bun.file(join(root, "archive/tasks/preview/TASK.md")).exists(),
		).toBe(false)

		await runTestEffect(
			ArchiveService.pipe(
				Effect.flatMap((service) => service.archiveTask("preview", root)),
			),
		)
		const restorePreview = await runTestEffect(
			ArchiveService.pipe(
				Effect.flatMap((service) =>
					service.restoreTask("preview", root, { dryRun: true }),
				),
			),
		)
		expect(restorePreview.dryRun).toBe(true)
		expect(await Bun.file(join(root, "tasks/preview/TASK.md")).exists()).toBe(
			false,
		)
		expect(
			await Bun.file(join(root, "archive/tasks/preview/TASK.md")).exists(),
		).toBe(true)
	})

	test("lists, filters, shows, and restores a task with provenance", async () => {
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
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "child",
							ticketUrl: null,
							epic: "parent",
							repo: "agency",
							branch: "task/child",
							base: "main",
						},
						root,
					),
				),
			),
		)
		await runTestEffect(
			ArchiveService.pipe(
				Effect.flatMap((service) => service.archiveTask("child", root)),
			),
		)

		const records = await runTestEffect(
			ArchiveService.pipe(
				Effect.flatMap((service) =>
					service.list(
						{ kinds: ["task"], repositories: ["agency"], statuses: ["open"] },
						root,
					),
				),
			),
		)
		expect(records.map((record) => record.id)).toEqual(["child"])
		const archived = await runTestEffect(
			ArchiveService.pipe(
				Effect.flatMap((service) =>
					service.show("task", "child", undefined, root),
				),
			),
		)
		expect(archived.provenance?.parent).toEqual({
			kind: "epic",
			id: "parent",
			declaration: { id: "child" },
		})
		expect(archived.provenance?.history[0]?.operation).toBe("archive")

		await runTestEffect(
			ArchiveService.pipe(
				Effect.flatMap((service) => service.restoreTask("child", root)),
			),
		)
		const epic = await runTestEffect(
			EpicService.pipe(
				Effect.flatMap((service) => service.show("parent", root)),
			),
		)
		expect(epic.data.tasks).toEqual([{ id: "child" }])
		const provenance = await Bun.file(
			join(root, "tasks/child/.agency-lifecycle.json"),
		).json()
		expect(
			provenance.history.map((item: { operation: string }) => item.operation),
		).toEqual(["archive", "restore"])
	})

	test("preserves phase dependencies across archive and restore", async () => {
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
		for (const [id, dependsOn] of [
			["first", undefined],
			["second", ["first"]],
		] as const) {
			await runTestEffect(
				PhaseService.pipe(
					Effect.flatMap((service) =>
						service.create(
							{
								taskId: "multi",
								id,
								repo: "agency",
								branch: `task/${id}`,
								base: "main",
								...(dependsOn ? { dependsOn } : {}),
							},
							root,
						),
					),
				),
			)
		}
		await runTestEffect(
			ArchiveService.pipe(
				Effect.flatMap((service) =>
					service.archivePhase("multi", "second", root),
				),
			),
		)
		await expect(
			runTestEffect(
				PhaseService.pipe(
					Effect.flatMap((service) =>
						service.create(
							{
								taskId: "multi",
								id: "second",
								repo: "agency",
								branch: "task/recreated-second",
								base: "main",
							},
							root,
						),
					),
				),
			),
		).rejects.toThrow("is archived; restore it")
		await runTestEffect(
			ArchiveService.pipe(
				Effect.flatMap((service) =>
					service.restorePhase("multi", "second", root),
				),
			),
		)
		const task = await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) => service.show("multi", root)),
			),
		)
		expect("phases" in task.data && task.data.phases).toEqual([
			{ id: "first" },
			{ id: "second", dependsOn: ["first"] },
		])
	})

	test("preflights missing dependencies before restoring", async () => {
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
		for (const [id, dependsOn] of [
			["first", undefined],
			["second", ["first"]],
		] as const) {
			await runTestEffect(
				PhaseService.pipe(
					Effect.flatMap((service) =>
						service.create(
							{
								taskId: "multi",
								id,
								repo: "agency",
								branch: `task/${id}`,
								base: "main",
								...(dependsOn ? { dependsOn } : {}),
							},
							root,
						),
					),
				),
			)
		}
		await runTestEffect(
			ArchiveService.pipe(
				Effect.flatMap((service) =>
					service.archivePhase("multi", "second", root),
				),
			),
		)
		await runTestEffect(
			ArchiveService.pipe(
				Effect.flatMap((service) =>
					service.archivePhase("multi", "first", root),
				),
			),
		)
		await expect(
			runTestEffect(
				ArchiveService.pipe(
					Effect.flatMap((service) =>
						service.restorePhase("multi", "second", root),
					),
				),
			),
		).rejects.toThrow("dependency 'first'")
		expect(
			await Bun.file(
				join(root, "archive/tasks/multi/phases/second/PHASE.md"),
			).exists(),
		).toBe(true)
	})

	test("restores an epic and its task cohort", async () => {
		await runTestEffect(
			EpicService.pipe(
				Effect.flatMap((service) =>
					service.create(
						"initiative",
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
							id: "delivery",
							ticketUrl: null,
							epic: "initiative",
							repo: "agency",
							branch: "task/delivery",
							base: "main",
						},
						root,
					),
				),
			),
		)
		await runTestEffect(
			ArchiveService.pipe(
				Effect.flatMap((service) => service.archiveEpic("initiative", root)),
			),
		)
		await expect(
			runTestEffect(
				EpicService.pipe(
					Effect.flatMap((service) =>
						service.create(
							"initiative",
							"https://example.com/recreated",
							[{ repo: "agency", ref: "main" }],
							root,
						),
					),
				),
			),
		).rejects.toThrow("is archived; restore it")
		await runTestEffect(
			ArchiveService.pipe(
				Effect.flatMap((service) => service.restoreEpic("initiative", root)),
			),
		)
		expect(
			await Bun.file(join(root, "epics/initiative/EPIC.md")).exists(),
		).toBe(true)
		expect(await Bun.file(join(root, "tasks/delivery/TASK.md")).exists()).toBe(
			true,
		)
		const report = await runTestEffect(
			WorkbaseService.pipe(Effect.flatMap((service) => service.validate(root))),
		)
		expect(report.valid).toBe(true)
	})

	test("rejects recreating archived entity IDs", async () => {
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "reserved",
							ticketUrl: null,
							repo: "agency",
							branch: "task/reserved",
							base: "main",
						},
						root,
					),
				),
			),
		)
		await runTestEffect(
			ArchiveService.pipe(
				Effect.flatMap((service) => service.archiveTask("reserved", root)),
			),
		)
		await expect(
			runTestEffect(
				TaskService.pipe(
					Effect.flatMap((service) =>
						service.create(
							{
								id: "reserved",
								ticketUrl: null,
								repo: "agency",
								branch: "task/new-reserved",
								base: "main",
							},
							root,
						),
					),
				),
			),
		).rejects.toThrow("is archived; restore it")
	})

	test("does not remove worktrees when another lifecycle mutation holds the lock", async () => {
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "locked",
							ticketUrl: null,
							repo: "agency",
							branch: "task/locked",
							base: "main",
						},
						root,
					),
				),
			),
		)
		const workspace = await runTestEffect(
			WorktreeService.pipe(
				Effect.flatMap((service) =>
					service.materialize("locked", undefined, root),
				),
			),
		)
		await Bun.write(join(root, ".agency-archive.lock"), "held\n")

		await expect(
			runTestEffect(
				ArchiveService.pipe(
					Effect.flatMap((service) => service.archiveTask("locked", root)),
				),
			),
		).rejects.toThrow("Another archive or restore operation")
		expect(
			await Bun.file(join(workspace.writablePath, "README.md")).exists(),
		).toBe(true)
		expect(await Bun.file(join(root, "tasks/locked/TASK.md")).exists()).toBe(
			true,
		)
	})

	test("rejects conflicting provenance and restore destinations", async () => {
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
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "child",
							ticketUrl: null,
							epic: "parent",
							repo: "agency",
							branch: "task/child",
							base: "main",
						},
						root,
					),
				),
			),
		)
		await runTestEffect(
			ArchiveService.pipe(
				Effect.flatMap((service) => service.archiveTask("child", root)),
			),
		)
		const manifestPath = join(
			root,
			"archive/tasks/child/.agency-lifecycle.json",
		)
		const manifest = await Bun.file(manifestPath).json()
		manifest.parent.declaration.id = "different"
		await Bun.write(manifestPath, JSON.stringify(manifest, null, 2) + "\n")
		await expect(
			runTestEffect(
				ArchiveService.pipe(
					Effect.flatMap((service) => service.restoreTask("child", root)),
				),
			),
		).rejects.toThrow("conflicting parent declaration ID")

		manifest.parent.declaration.id = "child"
		await Bun.write(manifestPath, JSON.stringify(manifest, null, 2) + "\n")
		const archivedTaskPath = join(root, "archive/tasks/child/TASK.md")
		const archivedTask = await Bun.file(archivedTaskPath).text()
		await Bun.write(
			archivedTaskPath,
			archivedTask.replace("epic: parent\n", ""),
		)
		await expect(
			runTestEffect(
				ArchiveService.pipe(
					Effect.flatMap((service) => service.restoreTask("child", root)),
				),
			),
		).rejects.toThrow("missing its epic backlink")
		await Bun.write(archivedTaskPath, archivedTask)
		await mkdir(join(root, "tasks/child"), { recursive: true })
		await expect(
			runTestEffect(
				ArchiveService.pipe(
					Effect.flatMap((service) => service.restoreTask("child", root)),
				),
			),
		).rejects.toThrow("Restore destination already exists")
		expect(
			await Bun.file(join(root, "archive/tasks/child/TASK.md")).exists(),
		).toBe(true)
	})

	test("reserves IDs for incomplete archive directories", async () => {
		await mkdir(join(root, "archive/epics/interrupted"), { recursive: true })
		await expect(
			runTestEffect(
				EpicService.pipe(
					Effect.flatMap((service) =>
						service.create(
							"interrupted",
							"https://example.com/epic",
							[{ repo: "agency", ref: "main" }],
							root,
						),
					),
				),
			),
		).rejects.toThrow("is archived; restore it")
	})

	test("preflights every phase worktree before removing any of them", async () => {
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "multi-dirty",
							ticketUrl: "https://example.com/task",
							multiPhase: true,
						},
						root,
					),
				),
			),
		)
		for (const id of ["clean", "dirty"]) {
			await runTestEffect(
				PhaseService.pipe(
					Effect.flatMap((service) =>
						service.create(
							{
								taskId: "multi-dirty",
								id,
								repo: "agency",
								branch: `task/${id}`,
								base: "main",
							},
							root,
						),
					),
				),
			)
			await runTestEffect(
				WorktreeService.pipe(
					Effect.flatMap((service) =>
						service.materialize("multi-dirty", id, root),
					),
				),
			)
		}
		await Bun.write(
			join(root, "tasks/multi-dirty/phases/dirty/code/agency/dirty.txt"),
			"keep me\n",
		)

		await expect(
			runTestEffect(
				ArchiveService.pipe(
					Effect.flatMap((service) => service.archiveTask("multi-dirty", root)),
				),
			),
		).rejects.toThrow("uncommitted changes")
		expect(
			await Bun.file(
				join(root, "tasks/multi-dirty/phases/clean/code/agency/README.md"),
			).exists(),
		).toBe(true)
	})
})
