import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import {
	captureErrors,
	cleanupTempDir,
	createTempDir,
	runTestEffect,
} from "../test-utils"
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

	test("does not fetch the origin for an existing writable worktree", async () => {
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "existing",
							ticketUrl: "https://example.com/task",
							repo: "agency",
							branch: "task/existing",
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
					service.materialize("existing", undefined, root),
				),
			),
		)
		await git(
			["remote", "set-url", "origin", join(root, "missing")],
			join(root, "repos/agency"),
		)
		const reused = await runTestEffect(
			WorktreeService.pipe(
				Effect.flatMap((service) =>
					service.materialize("existing", undefined, root),
				),
			),
		)
		expect(reused.checkouts).toEqual([
			expect.objectContaining({ repo: "agency", action: "reused" }),
		])
		expect(reused.operations).toEqual([])
	})

	test("reuses an immutable reference checkout without fetching", async () => {
		const commit = new TextDecoder()
			.decode(
				Bun.spawnSync(
					["git", "-C", join(root, "repos/effect"), "rev-parse", "main"],
					{ stdout: "pipe" },
				).stdout,
			)
			.trim()
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "immutable-reference",
							ticketUrl: "https://example.com/task",
							repo: "agency",
							repos: [{ repo: "effect", ref: commit }],
							branch: "task/immutable-reference",
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
					service.materialize("immutable-reference", undefined, root),
				),
			),
		)
		await git(
			["remote", "set-url", "origin", join(root, "missing")],
			join(root, "repos/effect"),
		)

		await expect(
			runTestEffect(
				WorktreeService.pipe(
					Effect.flatMap((service) =>
						service.materialize("immutable-reference", undefined, root),
					),
				),
			),
		).resolves.toMatchObject({ repos: [{ repo: "effect", ref: commit }] })
	})

	test("stops before materializing when workbase validation fails", async () => {
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "valid-target",
							ticketUrl: "https://example.com/task",
							repo: "agency",
							branch: "task/valid-target",
							base: "main",
						},
						root,
					),
				),
			),
		)
		await mkdir(join(root, "tasks", "missing-document"), { recursive: true })

		await expect(
			runTestEffect(
				WorktreeService.pipe(
					Effect.flatMap((service) =>
						service.materialize("valid-target", undefined, root),
					),
				),
			),
		).rejects.toThrow("Required document is missing")
		expect(
			await Bun.file(join(root, "tasks", "valid-target", "code")).exists(),
		).toBe(false)

		await expect(
			runTestEffect(
				WorktreeService.pipe(
					Effect.flatMap((service) =>
						service.materialize("valid-target", undefined, root, {
							force: true,
						}),
					),
				),
			),
		).resolves.toMatchObject({ repo: "agency" })
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

	test("logs the expanded configured command in verbose mode", async () => {
		await Bun.write(
			join(root, "agency.json"),
			JSON.stringify({
				version: 2,
				worktreeCreateCommand: [
					"sh",
					"-c",
					'git -C "$1" worktree add -b "$3" "$2" "$4" >/dev/null 2>&1',
					"agency-worktree",
					"{repo}",
					"{worktree}",
					"{branch}",
					"{base}",
				],
			}),
		)
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "verbose-command",
							ticketUrl: "https://example.com/task",
							repo: "agency",
							branch: "task/verbose-command",
							base: "main",
						},
						root,
					),
				),
			),
		)

		const logs = await captureErrors(() =>
			runTestEffect(
				WorktreeService.pipe(
					Effect.flatMap((service) =>
						service.materialize("verbose-command", undefined, root, {
							verbose: true,
						}),
					),
				),
			),
		)

		expect(logs).toHaveLength(1)
		expect(logs[0]).toStartWith("Running worktree command: sh -c ")
		expect(logs[0]).toContain(join(root, "repos", "agency"))
		expect(logs[0]).toContain(
			join(root, "tasks", "verbose-command", "code", "agency"),
		)
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
				expected: "Unknown repository alias 'missing'",
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
			await rm(taskDirectory, { recursive: true, force: true })
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

	test("fetches a moving ref before checking a reused reference checkout", async () => {
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "pinned-reference",
							ticketUrl: "https://example.com/task",
							repo: "agency",
							repos: [{ repo: "effect", ref: "origin/main" }],
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

		await expect(
			runTestEffect(
				WorktreeService.pipe(
					Effect.flatMap((service) =>
						service.materialize("pinned-reference", undefined, root),
					),
				),
			),
		).rejects.toThrow("does not match reference 'origin/main'")
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

	test("removes worktrees without deleting branches", async () => {
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "removable",
							ticketUrl: "https://example.com/task",
							repo: "agency",
							repos: [{ repo: "effect", ref: "main" }],
							branch: "task/removable",
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
					service.materialize("removable", undefined, root),
				),
			),
		)

		const removed = await runTestEffect(
			WorktreeService.pipe(
				Effect.flatMap((service) =>
					service.remove("removable", undefined, root),
				),
			),
		)

		expect(removed.sort()).toEqual(
			[
				join(workspace.codePath, "agency"),
				join(workspace.codePath, "effect"),
			].sort(),
		)
		expect(await Bun.file(workspace.codePath).exists()).toBe(false)
		const branch = Bun.spawnSync([
			"git",
			"-C",
			join(root, "repos/agency"),
			"show-ref",
			"--verify",
			"refs/heads/task/removable",
		])
		expect(branch.exitCode).toBe(0)
		expect(workspace.checkouts).toEqual([
			expect.objectContaining({
				repo: "agency",
				kind: "writable",
				action: "created",
				resolvedCommit: expect.stringMatching(/^[0-9a-f]{40}$/),
			}),
			expect.objectContaining({
				repo: "effect",
				kind: "reference",
				action: "created",
				resolvedCommit: expect.stringMatching(/^[0-9a-f]{40}$/),
			}),
		])
	})

	test("reports dry-run fetch and worktree changes without mutating", async () => {
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "planned",
							ticketUrl: "https://example.com/task",
							repo: "agency",
							repos: [{ repo: "effect", ref: "main" }],
							branch: "task/planned",
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
					service.materialize("planned", undefined, root, { dryRun: true }),
				),
			),
		)

		expect(workspace.dryRun).toBe(true)
		expect(
			workspace.checkouts.every(({ resolvedCommit }) => resolvedCommit),
		).toBe(true)
		expect(
			workspace.checkouts.map(({ repo, action }) => ({ repo, action })),
		).toEqual([
			{ repo: "agency", action: "created" },
			{ repo: "effect", action: "created" },
		])
		expect(workspace.operations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ action: "fetch", status: "planned" }),
				expect.objectContaining({
					action: "create-worktree",
					status: "planned",
				}),
			]),
		)
		expect(await Bun.file(workspace.codePath).exists()).toBe(false)
		expect(
			Bun.spawnSync([
				"git",
				"-C",
				join(root, "repos/agency"),
				"show-ref",
				"--verify",
				"refs/heads/task/planned",
			]).exitCode,
		).not.toBe(0)
	})

	test("refuses to remove a worktree with uncommitted changes", async () => {
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
		await Bun.write(
			join(workspace.writablePath, "uncommitted.txt"),
			"keep me\n",
		)

		await expect(
			runTestEffect(
				WorktreeService.pipe(
					Effect.flatMap((service) => service.remove("dirty", undefined, root)),
				),
			),
		).rejects.toThrow("Failed to remove worktree for 'agency'")
		expect(
			await Bun.file(join(workspace.writablePath, "uncommitted.txt")).text(),
		).toBe("keep me\n")
	})

	test("handles a missing checkout without deleting its branch", async () => {
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "stale",
							ticketUrl: "https://example.com/task",
							repo: "agency",
							branch: "task/stale",
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
					service.materialize("stale", undefined, root),
				),
			),
		)
		await rm(workspace.codePath, { recursive: true })

		const removed = await runTestEffect(
			WorktreeService.pipe(
				Effect.flatMap((service) => service.remove("stale", undefined, root)),
			),
		)

		expect(removed).toEqual([])
		const worktrees = Bun.spawnSync([
			"git",
			"-C",
			join(root, "repos/agency"),
			"worktree",
			"list",
			"--porcelain",
		])
		expect(new TextDecoder().decode(worktrees.stdout)).not.toContain(
			workspace.writablePath,
		)
		expect(
			Bun.spawnSync([
				"git",
				"-C",
				join(root, "repos/agency"),
				"show-ref",
				"--verify",
				"refs/heads/task/stale",
			]).exitCode,
		).toBe(0)
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
