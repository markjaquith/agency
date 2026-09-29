import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import {
	captureLogs,
	cleanupTempDir,
	createTempDir,
	runTestEffect,
} from "../test-utils"
import { TaskService } from "./TaskService"
import { PhaseService } from "./PhaseService"
import { WorkbaseService } from "./WorkbaseService"
import { WorktreeService } from "./WorktreeService"
import { EpicService } from "./EpicService"
import { GraphMutationService } from "./GraphMutationService"
import { task } from "../commands/task"
import { phase } from "../commands/phase"

const git = async (args: string[], cwd?: string) => {
	const child = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	})
	if ((await child.exited) !== 0)
		throw new Error(await new Response(child.stderr).text())
}

describe("automatic task archival", () => {
	let root: string
	const enable = () =>
		runTestEffect(
			WorkbaseService.pipe(
				Effect.flatMap((service) => service.setAutoArchive(true, root)),
			),
		)
	const create = (id = "example", epic?: string) =>
		runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id,
							ticketUrl: null,
							repo: "agency",
							branch: `task/${id}`,
							base: "main",
							...(epic ? { epic } : {}),
						},
						root,
					),
				),
			),
		)
	const drop = (id = "example", cwd = root) =>
		runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) => service.setStatus(id, "dropped", cwd)),
			),
		)
	const active = (id = "example") =>
		Bun.file(join(root, "tasks", id, "TASK.md"))
	const archived = (id = "example") =>
		Bun.file(join(root, "archive/tasks", id, "TASK.md"))

	beforeEach(async () => {
		root = await createTempDir()
		await Bun.write(join(root, "agency.json"), '{"version":2}\n')
		const source = join(root, "source")
		await mkdir(source)
		await git(["init", "--initial-branch=main"], source)
		await git(["config", "user.email", "test@example.com"], source)
		await git(["config", "user.name", "Test"], source)
		await Bun.write(join(source, "README.md"), "example\n")
		await git(["add", "README.md"], source)
		await git(["-c", "commit.gpgsign=false", "commit", "-m", "initial"], source)
		await mkdir(join(root, "repos"))
		await git(["clone", "--bare", source, join(root, "repos/agency")])
	})
	afterEach(async () => cleanupTempDir(root))

	test("defaults off and enabling does not sweep existing terminal tasks", async () => {
		await create()
		expect((await drop()).autoArchive?.status).toBe("disabled")
		await enable()
		expect(await active().exists()).toBe(true)
		expect(await archived().exists()).toBe(false)
	})

	test("archives a dropped task and reports the result as JSON", async () => {
		await create()
		await enable()
		const logs = await captureLogs(() =>
			runTestEffect(
				task({
					subcommand: "status",
					args: ["example", "dropped"],
					cwd: root,
					json: true,
				}),
			),
		)
		expect(JSON.parse(logs[0]!).autoArchive).toMatchObject({
			taskId: "example",
			status: "archived",
			path: join(root, "archive/tasks/example"),
		})
		expect(await active().exists()).toBe(false)
		expect(await archived().text()).toContain("status: dropped")
	})

	test("disabling prevents cleanup and non-terminal mutations never attempt it", async () => {
		await create()
		await enable()
		const working = await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.setStatus("example", "working", root),
				),
			),
		)
		expect(working.autoArchive).toBeUndefined()
		await runTestEffect(
			WorkbaseService.pipe(
				Effect.flatMap((service) => service.setAutoArchive(false, root)),
			),
		)
		expect((await drop()).autoArchive?.status).toBe("disabled")
		expect(await active().exists()).toBe(true)
	})

	test("retains terminal work when its archive destination already exists", async () => {
		await create()
		await enable()
		await mkdir(join(root, "archive/tasks/example"), { recursive: true })
		await Bun.write(join(root, "archive/tasks/example/keep.txt"), "preserve")
		const result = await drop()
		expect(result.autoArchive).toMatchObject({
			status: "skipped",
			reason: expect.stringContaining("destination already exists"),
		})
		expect(await active().text()).toContain("status: dropped")
		expect(
			await Bun.file(join(root, "archive/tasks/example/keep.txt")).text(),
		).toBe("preserve")
	})

	test("archives explicit non-PR completion and removes clean checkouts even when invoked there", async () => {
		await create()
		await enable()
		const workspace = await runTestEffect(
			WorktreeService.pipe(
				Effect.flatMap((service) =>
					service.materialize("example", undefined, root),
				),
			),
		)
		const result = await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.setStatus("example", "done", workspace.writablePath!, {
						summary: "Investigation complete",
					}),
				),
			),
		)
		expect(result.autoArchive?.status).toBe("archived")
		expect(await archived().text()).toContain("Investigation complete")
		expect(
			await Bun.file(join(workspace.writablePath!, "README.md")).exists(),
		).toBe(false)
	})

	test("leaves dirty work unarchived after committing the terminal status and explains why", async () => {
		await create()
		await enable()
		const workspace = await runTestEffect(
			WorktreeService.pipe(
				Effect.flatMap((service) =>
					service.materialize("example", undefined, root),
				),
			),
		)
		await Bun.write(join(workspace.writablePath!, "dirty.txt"), "keep me")
		const logs = await captureLogs(() =>
			runTestEffect(
				task({ subcommand: "status", args: ["example", "dropped"], cwd: root }),
			),
		)
		expect(logs.join("\n")).toContain("Auto-archive skipped")
		expect(logs.join("\n")).toMatch(/dirty|uncommitted/i)
		expect(await active().text()).toContain("status: dropped")
		expect(await archived().exists()).toBe(false)
		expect(
			await Bun.file(join(workspace.writablePath!, "dirty.txt")).text(),
		).toBe("keep me")
	})

	test("preserves dependency declarations when archive preflight refuses a parent removal", async () => {
		await runTestEffect(
			EpicService.pipe(
				Effect.flatMap((service) =>
					service.create(
						"epic",
						"https://example.com/ticket",
						[{ repo: "agency", ref: "main" }],
						root,
					),
				),
			),
		)
		await create("example", "epic")
		await create("dependent", "epic")
		await runTestEffect(
			GraphMutationService.pipe(
				Effect.flatMap((service) =>
					service.mutateTaskDependency("add", "dependent", "example", root),
				),
			),
		)
		await enable()
		const result = await drop()
		expect(result.autoArchive).toMatchObject({
			status: "skipped",
			reason: expect.stringContaining("depends on it"),
		})
		expect(await active().exists()).toBe(true)
	})

	test("waits for every phase and archives the owning task, not individual phases", async () => {
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
		for (const id of ["first", "last"])
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
		await enable()
		const first = await runTestEffect(
			PhaseService.pipe(
				Effect.flatMap((service) =>
					service.setStatus("multi", "first", "dropped", root),
				),
			),
		)
		expect(first.autoArchive?.status).toBe("non-terminal")
		expect(await active("multi").exists()).toBe(true)
		const logs = await captureLogs(() =>
			runTestEffect(
				phase({
					subcommand: "status",
					args: ["multi", "last", "done"],
					noPullRequest: true,
					summary: "Done",
					cwd: root,
					json: true,
				}),
			),
		)
		expect(JSON.parse(logs[0]!).autoArchive.status).toBe("archived")
		expect(await active("multi").exists()).toBe(false)
		expect(await archived("multi").exists()).toBe(true)
		expect(
			await Bun.file(
				join(root, "archive/tasks/multi/phases/first/PHASE.md"),
			).exists(),
		).toBe(true)
	})
})
