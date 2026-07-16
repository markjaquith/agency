import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { cleanupTempDir, createTempDir, runTestEffect } from "../test-utils"
import { TaskService } from "./TaskService"
import { PhaseService } from "./PhaseService"
import { WorktreeService } from "./WorktreeService"

const git = async (args: string[], cwd?: string) => {
	const process = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	})
	await process.exited
	if (process.exitCode !== 0)
		throw new Error(await new Response(process.stderr).text())
}

describe("WorktreeService", () => {
	let root: string
	let source: string

	beforeEach(async () => {
		root = await createTempDir()
		await Bun.write(join(root, "agency.json"), '{"version":2}\n')
		source = join(root, "source")
		await mkdir(source, { recursive: true })
		await git(["init", "--initial-branch=main"], source)
		await git(["config", "user.email", "test@example.com"], source)
		await git(["config", "user.name", "Test"], source)
		await Bun.write(join(source, "README.md"), "example\n")
		await git(["add", "README.md"], source)
		await git(["-c", "commit.gpgsign=false", "commit", "-m", "initial"], source)
		await mkdir(join(root, "repos"), { recursive: true })
		await git(["clone", "--bare", source, join(root, "repos/agency")])
		await git(["clone", "--bare", source, join(root, "repos/effect")])
	})

	afterEach(async () => cleanupTempDir(root))

	test("materializes writable and reference worktrees", async () => {
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "example",
							ticketUrl: "https://example.com/task",
							repo: "agency",
							repos: [{ repo: "effect", ref: "main" }],
							branch: "task/example",
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
					service.materialize("example", undefined, root),
				),
			),
		)

		expect(
			await Bun.file(join(workspace.writablePath, "README.md")).text(),
		).toBe("example\n")
		expect(
			await Bun.file(join(workspace.codePath, "effect/README.md")).text(),
		).toBe("example\n")
		const branch = Bun.spawnSync(
			["git", "-C", workspace.writablePath, "branch", "--show-current"],
			{ stdout: "pipe" },
		)
		expect(new TextDecoder().decode(branch.stdout).trim()).toBe("task/example")
	})

	test("uses a configured worktree creation command", async () => {
		await Bun.write(
			join(root, "agency.json"),
			JSON.stringify({
				version: 2,
				worktreeCreateCommand: [
					"git",
					"-C",
					"{repo}",
					"worktree",
					"add",
					"-b",
					"{branch}",
					"{worktree}",
					"{base}",
				],
			}),
		)
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "configured",
							ticketUrl: "https://example.com/task",
							repo: "agency",
							branch: "task/configured",
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
					service.materialize("configured", undefined, root),
				),
			),
		)
		expect(
			await Bun.file(join(workspace.writablePath, "README.md")).text(),
		).toBe("example\n")
	})

	test("selects phases and rejects missing or unexpected phase IDs", async () => {
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
							id: "selected",
							repo: "agency",
							branch: "task/selected",
							base: "main",
						},
						root,
					),
				),
			),
		)

		await expect(
			runTestEffect(
				WorktreeService.pipe(
					Effect.flatMap((service) =>
						service.materialize("multi", undefined, root),
					),
				),
			),
		).rejects.toThrow("phase ID is required")
		await expect(
			runTestEffect(
				WorktreeService.pipe(
					Effect.flatMap((service) =>
						service.materialize("multi", "missing", root),
					),
				),
			),
		).rejects.toThrow("Phase 'missing' does not exist on task 'multi'")

		const workspace = await runTestEffect(
			WorktreeService.pipe(
				Effect.flatMap((service) =>
					service.materialize("multi", "selected", root),
				),
			),
		)
		expect(workspace.phasePath).toBe(
			join(root, "tasks/multi/phases/selected/PHASE.md"),
		)
		expect(workspace.writablePath).toBe(
			join(root, "tasks/multi/phases/selected/code/agency"),
		)

		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "single",
							ticketUrl: "https://example.com/task",
							repo: "effect",
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
				WorktreeService.pipe(
					Effect.flatMap((service) =>
						service.materialize("single", "unexpected", root),
					),
				),
			),
		).rejects.toThrow("does not accept a phase ID")
	})

	test("reports meaningful worktree creation failures", async () => {
		const cases = [
			{
				id: "missing-repo",
				repo: "missing",
				base: "main",
				config: { version: 2 },
				expected: "Repository alias 'missing' does not exist",
			},
			{
				id: "bad-base",
				repo: "agency",
				base: "absent-base",
				config: { version: 2 },
				expected: "Failed to create branch 'task/bad-base'",
			},
			{
				id: "failed-command",
				repo: "agency",
				base: "main",
				config: {
					version: 2,
					worktreeCreateCommand: [
						"sh",
						"-c",
						"echo command-failed >&2; exit 7",
						"{repo}",
						"{worktree}",
					],
				},
				expected: "Failed to create worktree for 'agency': command-failed",
			},
			{
				id: "missing-destination",
				repo: "agency",
				base: "main",
				config: {
					version: 2,
					worktreeCreateCommand: ["sh", "-c", "exit 0", "{repo}", "{worktree}"],
				},
				expected: "Worktree command did not create",
			},
		] as const

		for (const fixture of cases) {
			await Bun.write(join(root, "agency.json"), JSON.stringify(fixture.config))
			const taskDirectory = join(root, "tasks", fixture.id)
			await mkdir(taskDirectory, { recursive: true })
			await Bun.write(
				join(taskDirectory, "TASK.md"),
				`---
ticketUrl: https://example.com/tasks/${fixture.id}
repo: ${fixture.repo}
branch: task/${fixture.id}
base: ${fixture.base}
pr: null
---
`,
			)

			await expect(
				runTestEffect(
					WorktreeService.pipe(
						Effect.flatMap((service) =>
							service.materialize(fixture.id, undefined, root),
						),
					),
				),
			).rejects.toThrow(fixture.expected)
		}
	})

	test("moves and repairs an existing worktree when converting a task", async () => {
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "promoted",
							ticketUrl: "https://example.com/task",
							repo: "agency",
							branch: "task/promoted",
							base: "main",
						},
						root,
					),
				),
			),
		)
		const originalWorkspace = await runTestEffect(
			WorktreeService.pipe(
				Effect.flatMap((service) =>
					service.materialize("promoted", undefined, root),
				),
			),
		)

		await runTestEffect(
			PhaseService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							taskId: "promoted",
							id: "follow-up",
							firstPhase: "implementation",
							repo: "agency",
							branch: "task/follow-up",
							base: "main",
						},
						root,
					),
				),
			),
		)

		expect(
			await Bun.file(
				join(originalWorkspace.writablePath, "README.md"),
			).exists(),
		).toBe(false)
		const movedWorkspace = await runTestEffect(
			WorktreeService.pipe(
				Effect.flatMap((service) =>
					service.materialize("promoted", "implementation", root),
				),
			),
		)
		expect(movedWorkspace.writablePath).toBe(
			join(root, "tasks/promoted/phases/implementation/code/agency"),
		)
		expect(
			await Bun.file(join(movedWorkspace.writablePath, "README.md")).text(),
		).toBe("example\n")
		const status = Bun.spawnSync(
			["git", "-C", movedWorkspace.writablePath, "status", "--porcelain"],
			{ stdout: "pipe", stderr: "pipe" },
		)
		expect(status.exitCode).toBe(0)
	})

	test("rejects a writable branch checked out in another worktree", async () => {
		const repository = join(root, "repos/agency")
		await git(["-C", repository, "branch", "task/shared", "main"])
		const outside = join(root, "outside")
		await git(["-C", repository, "worktree", "add", outside, "task/shared"])
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "conflict",
							ticketUrl: "https://example.com/task",
							repo: "agency",
							branch: "task/shared",
							base: "main",
						},
						root,
					),
				),
			),
		)

		await expect(
			runTestEffect(
				WorktreeService.pipe(
					Effect.flatMap((service) =>
						service.materialize("conflict", undefined, root),
					),
				),
			),
		).rejects.toThrow("already checked out at")
	})

	test("rejects duplicate Agency ownership before materializing", async () => {
		for (const id of ["first-owner", "second-owner"]) {
			await runTestEffect(
				TaskService.pipe(
					Effect.flatMap((service) =>
						service.create(
							{
								id,
								ticketUrl: `https://example.com/${id}`,
								repo: "agency",
								branch: "task/shared-owner",
								base: "main",
							},
							root,
						),
					),
				),
			)
		}

		await expect(
			runTestEffect(
				WorktreeService.pipe(
					Effect.flatMap((service) =>
						service.materialize("first-owner", undefined, root),
					),
				),
			),
		).rejects.toThrow("also owned by tasks/first-owner/TASK.md")
	})

	test("rejects an existing Agency checkout on the wrong branch", async () => {
		const repository = join(root, "repos/agency")
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "wrong",
							ticketUrl: "https://example.com/task",
							repo: "agency",
							branch: "task/expected",
							base: "main",
						},
						root,
					),
				),
			),
		)
		await git(["-C", repository, "branch", "task/wrong", "main"])
		const checkout = join(root, "tasks/wrong/code/agency")
		await mkdir(join(root, "tasks/wrong/code"), { recursive: true })
		await git(["-C", repository, "worktree", "add", checkout, "task/wrong"])

		await expect(
			runTestEffect(
				WorktreeService.pipe(
					Effect.flatMap((service) =>
						service.materialize("wrong", undefined, root),
					),
				),
			),
		).rejects.toThrow("is not registered to branch 'task/expected'")
	})

	test("rejects a reused reference checkout after its ref advances", async () => {
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "pinned-reference",
							ticketUrl: "https://example.com/task",
							repo: "agency",
							repos: [{ repo: "effect", ref: "main" }],
							branch: "task/pinned-reference",
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
					service.materialize("pinned-reference", undefined, root),
				),
			),
		)

		await Bun.write(join(source, "README.md"), "updated\n")
		await git(["add", "README.md"], source)
		await git(["-c", "commit.gpgsign=false", "commit", "-m", "update"], source)
		await git(["push", join(root, "repos/effect"), "main"], source)

		await expect(
			runTestEffect(
				WorktreeService.pipe(
					Effect.flatMap((service) =>
						service.materialize("pinned-reference", undefined, root),
					),
				),
			),
		).rejects.toThrow("does not match reference 'main'")
	})

	test("rejects a reference checkout attached to a branch", async () => {
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "attached-reference",
							ticketUrl: "https://example.com/task",
							repo: "agency",
							repos: [{ repo: "effect", ref: "main" }],
							branch: "task/attached-reference",
							base: "main",
						},
						root,
					),
				),
			),
		)
		const checkout = join(root, "tasks/attached-reference/code/effect")
		await mkdir(join(root, "tasks/attached-reference/code"), {
			recursive: true,
		})
		await git([
			"-C",
			join(root, "repos/effect"),
			"worktree",
			"add",
			checkout,
			"main",
		])

		await expect(
			runTestEffect(
				WorktreeService.pipe(
					Effect.flatMap((service) =>
						service.materialize("attached-reference", undefined, root),
					),
				),
			),
		).rejects.toThrow("is attached to branch 'main'")
	})

	test("supports Worktrunk as the configured command", async () => {
		if (Bun.spawnSync(["which", "wt"], { stdout: "ignore" }).exitCode !== 0) {
			return
		}

		await Bun.write(
			join(root, "agency.json"),
			JSON.stringify({
				version: 2,
				worktreeCreateCommand: [
					"wt",
					"-C",
					"{repo}",
					"-y",
					"--config-set",
					'worktree-path="{worktree}"',
					"switch",
					"--create",
					"--base",
					"{base}",
					"{branch}",
					"--no-cd",
					"--format",
					"json",
				],
			}),
		)
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "worktrunk",
							ticketUrl: "https://example.com/task",
							repo: "agency",
							branch: "task/worktrunk",
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
					service.materialize("worktrunk", undefined, root),
				),
			),
		)
		expect(
			await Bun.file(join(workspace.writablePath, "README.md")).text(),
		).toBe("example\n")
	})
})
