import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { chmod, mkdir, rm } from "node:fs/promises"
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

const jj = (args: readonly string[], cwd?: string) => {
	const result = Bun.spawnSync(["jj", ...args], { cwd })
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

	test("skips task- and phase-level active claims", async () => {
		await createTask("claimed")
		await dropTask("claimed")
		const taskPath = join(root, "tasks/claimed/TASK.md")
		await Bun.write(
			taskPath,
			(await Bun.file(taskPath).text()).replace(
				"status: dropped\n",
				`status: dropped
claim:
  claimant: orchestrator
  runner: opencode
  sessionId: task-session
  startedAt: 2026-08-07T00:00:00.000Z
  targetRevision: ${"a".repeat(64)}
  state: active
`,
			),
		)
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{ id: "multi-claimed", ticketUrl: null, multiPhase: true },
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
							taskId: "multi-claimed",
							id: "phase",
							repo: "agency",
							branch: "task/multi-claimed",
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
					service.setStatus("multi-claimed", "phase", "dropped", root),
				),
			),
		)
		const phasePath = join(root, "tasks/multi-claimed/phases/phase/PHASE.md")
		await Bun.write(
			phasePath,
			(await Bun.file(phasePath).text()).replace(
				"status: dropped\n",
				`status: dropped
claim:
  claimant: orchestrator
  runner: opencode
  sessionId: phase-session
  startedAt: 2026-08-07T00:00:00.000Z
  targetRevision: ${"b".repeat(64)}
  state: active
`,
			),
		)

		const result = await archiveTasks(true)

		expect(result.tasks).toMatchObject([
			{
				id: "claimed",
				disposition: "skipped",
				reason: { code: "active-claim", details: ["task:claimed"] },
			},
			{
				id: "multi-claimed",
				disposition: "skipped",
				reason: {
					code: "active-claim",
					details: ["phase:multi-claimed/phase"],
				},
			},
		])
	})

	test("skips a dirty jj workspace", async () => {
		if (!Bun.which("jj")) return
		const repository = join(root, "repos/agency")
		await rm(repository, { recursive: true, force: true })
		git(["clone", source, repository])
		const initialized = Bun.spawnSync([
			"jj",
			"git",
			"init",
			"--colocate",
			repository,
		])
		if (initialized.exitCode !== 0) {
			throw new Error(new TextDecoder().decode(initialized.stderr))
		}
		await Bun.write(
			join(root, "agency.json"),
			JSON.stringify({ version: 2, vcs: "jj" }),
		)
		await createTask("jj-dirty")
		await dropTask("jj-dirty")
		const workspace = await runTestEffect(
			WorktreeService.pipe(
				Effect.flatMap((service) =>
					service.materialize("jj-dirty", undefined, root),
				),
			),
		)
		await Bun.write(join(workspace.writablePath!, "dirty.txt"), "keep\n")

		const result = await archiveTasks()

		expect(result.tasks[0]).toMatchObject({
			id: "jj-dirty",
			disposition: "skipped",
			reason: { code: "dirty-worktree" },
		})
		expect(
			await Bun.file(join(workspace.writablePath!, "dirty.txt")).exists(),
		).toBe(true)
	})

	test("archives a jj working-copy commit preserved by its task bookmark", async () => {
		if (!Bun.which("jj")) return
		const repository = join(root, "repos/agency")
		await rm(repository, { recursive: true, force: true })
		git(["clone", source, repository])
		jj(["git", "init", "--colocate", repository])
		await Bun.write(
			join(root, "agency.json"),
			JSON.stringify({ version: 2, vcs: "jj" }),
		)
		await createTask("jj-bookmarked")
		await dropTask("jj-bookmarked")
		const workspace = await runTestEffect(
			WorktreeService.pipe(
				Effect.flatMap((service) =>
					service.materialize("jj-bookmarked", undefined, root),
				),
			),
		)
		await Bun.write(join(workspace.writablePath!, "preserved.txt"), "keep\n")
		jj(
			["bookmark", "set", "task/jj-bookmarked", "-r", "@"],
			workspace.writablePath!,
		)

		const preview = await archiveTasks(true)
		expect(preview.tasks[0]).toMatchObject({
			id: "jj-bookmarked",
			disposition: "planned",
			removedWorktrees: [workspace.writablePath!],
		})
		expect(
			await Bun.file(join(workspace.writablePath!, "preserved.txt")).text(),
		).toBe("keep\n")

		const result = await archiveTasks()
		expect(result.tasks[0]).toMatchObject({
			id: "jj-bookmarked",
			disposition: "archived",
		})
		expect(await Bun.file(workspace.writablePath!).exists()).toBe(false)
		const preserved = Bun.spawnSync([
			"jj",
			"-R",
			repository,
			"file",
			"show",
			"-r",
			"task/jj-bookmarked",
			'root:"preserved.txt"',
		])
		if (preserved.exitCode !== 0) {
			throw new Error(preserved.stderr.toString())
		}
		expect(preserved.stdout.toString()).toBe("keep\n")
	})

	test("archives a forgotten jj workspace preserved by its task bookmark", async () => {
		if (!Bun.which("jj")) return
		const repository = join(root, "repos/agency")
		await rm(repository, { recursive: true, force: true })
		git(["clone", source, repository])
		jj(["git", "init", "--colocate", repository])
		await Bun.write(
			join(root, "agency.json"),
			JSON.stringify({ version: 2, vcs: "jj" }),
		)
		await createTask("jj-stale")
		await dropTask("jj-stale")
		const workspace = await runTestEffect(
			WorktreeService.pipe(
				Effect.flatMap((service) =>
					service.materialize("jj-stale", undefined, root),
				),
			),
		)
		await Bun.write(join(workspace.writablePath!, "preserved.txt"), "keep\n")
		jj(["bookmark", "set", "task/jj-stale", "-r", "@"], workspace.writablePath!)
		jj(["-R", repository, "workspace", "forget", "agency-jj-stale-task-agency"])

		const result = await archiveTasks(true)

		expect(result.tasks[0]).toMatchObject({
			id: "jj-stale",
			disposition: "planned",
			removedWorktrees: [workspace.writablePath!],
		})
		expect(
			await Bun.file(join(workspace.writablePath!, "preserved.txt")).text(),
		).toBe("keep\n")
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
