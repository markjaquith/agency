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

		expect(result.archivedPaths).toEqual([
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
})
