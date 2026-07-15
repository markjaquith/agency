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
							repos: ["effect"],
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
					"{worktree}",
					"{branch}",
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
