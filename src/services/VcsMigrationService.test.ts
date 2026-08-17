import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { lstat, mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { cleanupTempDir, createTempDir, runTestEffect } from "../test-utils"
import { ClaimService } from "./ClaimService"
import { TaskService } from "./TaskService"
import { VcsMigrationService } from "./VcsMigrationService"
import { WorktreeService } from "./WorktreeService"
import { runVcsStatusFast } from "../vcs-status-fast"

const run = async (args: string[], cwd?: string) => {
	const child = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" })
	const exitCode = await child.exited
	if (exitCode !== 0) throw new Error(await new Response(child.stderr).text())
	return new Response(child.stdout).text()
}

const exists = async (path: string) => {
	try {
		await lstat(path)
		return true
	} catch {
		return false
	}
}

describe("VcsMigrationService", () => {
	let root: string

	beforeEach(async () => {
		root = await createTempDir()
		await Bun.write(
			join(root, "agency.json"),
			JSON.stringify({ version: 2, vcs: "git" }),
		)
		const source = join(root, "source")
		await mkdir(source)
		await run(["git", "init", "--initial-branch=main"], source)
		await run(["git", "config", "user.email", "test@example.com"], source)
		await run(["git", "config", "user.name", "Test"], source)
		await Bun.write(join(source, "README.md"), "example\n")
		await run(["git", "add", "README.md"], source)
		await run(["git", "commit", "-m", "initial"], source)
		await mkdir(join(root, "repos"))
		await run(["git", "clone", "--bare", source, join(root, "repos/agency")])
		await run(["git", "clone", "--bare", source, join(root, "repos/effect")])
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "example",
							ticketUrl: null,
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
		await runTestEffect(
			WorktreeService.pipe(
				Effect.flatMap((service) =>
					service.materialize("example", undefined, root),
				),
			),
		)
	})

	afterEach(async () => cleanupTempDir(root))

	test("reports same-backend status for materialized workspaces", async () => {
		const status = await runTestEffect(
			VcsMigrationService.pipe(
				Effect.flatMap((service) => service.status(root)),
			),
		)
		expect(status).toMatchObject({
			configured: "git",
			source: "git",
			target: "git",
			workspaceCount: 2,
			blockers: [],
		})
	})

	test("fast jj status matches the validated service result", async () => {
		if (!Bun.which("jj")) return
		await runTestEffect(
			VcsMigrationService.pipe(
				Effect.flatMap((service) =>
					service.migrate("jj", root, { apply: true }),
				),
			),
		)
		const taskPath = join(root, "tasks/example/TASK.md")
		const content = await Bun.file(taskPath).text()
		const withoutReference = content.replace(
			/\nrepos:\n(?:  .+\n)+(?=branch:)/,
			"\n",
		)
		expect(withoutReference).not.toBe(content)
		await Bun.write(taskPath, withoutReference)

		const validated = await runTestEffect(
			VcsMigrationService.pipe(
				Effect.flatMap((service) => service.status(root)),
			),
		)
		const output: string[] = []
		expect(
			await runVcsStatusFast(true, root, (line) => output.push(line)),
		).toBe(true)
		expect(JSON.parse(output.join("\n")).result).toEqual(validated)
	})

	test("migrates Git worktrees to jj workspaces and back", async () => {
		if (!Bun.which("jj")) return
		const checkout = join(root, "tasks/example/code/agency")
		const reference = join(root, "tasks/example/code/effect")
		const dryRun = await runTestEffect(
			VcsMigrationService.pipe(
				Effect.flatMap((service) => service.migrate("jj", root)),
			),
		)
		expect(dryRun).toMatchObject({
			source: "git",
			target: "jj",
			mode: "dry-run",
			workspaceCount: 2,
		})
		expect((await Bun.file(join(root, "agency.json")).json()).vcs).toBe("git")

		const migrated = await runTestEffect(
			VcsMigrationService.pipe(
				Effect.flatMap((service) =>
					service.migrate("jj", root, { apply: true }),
				),
			),
		)
		expect(migrated.mode).toBe("apply")
		expect((await Bun.file(join(root, "agency.json")).json()).vcs).toBe("jj")
		expect(await exists(join(root, "repos/agency/.jj"))).toBe(true)
		expect(await exists(join(root, "repos/effect/.jj"))).toBe(true)
		expect(await exists(join(checkout, ".jj"))).toBe(true)
		expect(await exists(join(reference, ".jj"))).toBe(true)
		expect(
			await run(["jj", "-R", checkout, "log", "--no-graph", "-r", "@-"]),
		).toContain("initial")
		expect(
			(
				await runTestEffect(
					WorktreeService.pipe(
						Effect.flatMap((service) =>
							service.inspect("example", undefined, root),
						),
					),
				)
			).conflicts,
		).toEqual([])

		await runTestEffect(
			VcsMigrationService.pipe(
				Effect.flatMap((service) =>
					service.migrate("git", root, { apply: true }),
				),
			),
		)
		expect((await Bun.file(join(root, "agency.json")).json()).vcs).toBe("git")
		expect(await exists(join(root, "repos/agency/.jj"))).toBe(false)
		expect(await exists(join(root, "repos/effect/.jj"))).toBe(false)
		expect(await exists(join(checkout, ".git"))).toBe(true)
		expect(await exists(join(reference, ".git"))).toBe(true)
		expect(
			(await run(["git", "-C", checkout, "branch", "--show-current"])).trim(),
		).toBe("task/example")
		expect(
			(
				await run(["git", "-C", reference, "rev-parse", "--abbrev-ref", "HEAD"])
			).trim(),
		).toBe("HEAD")
		expect(
			(
				await runTestEffect(
					WorktreeService.pipe(
						Effect.flatMap((service) =>
							service.inspect("example", undefined, root),
						),
					),
				)
			).conflicts,
		).toEqual([])
	})

	test("blocks non-colocated jj to Git migration before mutation", async () => {
		if (!Bun.which("jj")) return
		await runTestEffect(
			WorktreeService.pipe(
				Effect.flatMap((service) => service.remove("example", undefined, root)),
			),
		)
		for (const alias of ["agency", "effect"]) {
			const repository = join(root, "repos", alias)
			await rm(repository, { recursive: true, force: true })
			await run([
				"jj",
				"git",
				"clone",
				"--no-colocate",
				join(root, "source"),
				repository,
			])
			expect(await exists(join(repository, ".git"))).toBe(false)
		}
		await Bun.write(
			join(root, "agency.json"),
			JSON.stringify({ version: 2, vcs: "jj" }),
		)

		const planned = await runTestEffect(
			VcsMigrationService.pipe(
				Effect.flatMap((service) => service.migrate("git", root)),
			),
		)
		expect(planned.blockers).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					target: "repository:agency",
					message: expect.stringContaining("non-colocated"),
				}),
				expect.objectContaining({
					target: "repository:effect",
					message: expect.stringContaining("non-colocated"),
				}),
			]),
		)
		expect((await Bun.file(join(root, "agency.json")).json()).vcs).toBe("jj")
		expect(await exists(join(root, "repos/agency/.jj"))).toBe(true)
		await expect(
			runTestEffect(
				VcsMigrationService.pipe(
					Effect.flatMap((service) =>
						service.migrate("git", root, { apply: true }),
					),
				),
			),
		).rejects.toThrow("non-colocated")
		expect((await Bun.file(join(root, "agency.json")).json()).vcs).toBe("jj")
		expect(await exists(join(root, "repos/agency/.jj"))).toBe(true)
	})

	test("allows clean unclaimed working workspaces", async () => {
		if (!Bun.which("jj")) return
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.setStatus("example", "working", root),
				),
			),
		)
		const migrated = await runTestEffect(
			VcsMigrationService.pipe(
				Effect.flatMap((service) =>
					service.migrate("jj", root, { apply: true }),
				),
			),
		)
		expect(migrated.mode).toBe("apply")
	})

	test("blocks active claims", async () => {
		if (!Bun.which("jj")) return
		const inspected = await runTestEffect(
			ClaimService.pipe(
				Effect.flatMap((service) =>
					service.inspect("example", undefined, root),
				),
			),
		)
		await runTestEffect(
			ClaimService.pipe(
				Effect.flatMap((service) =>
					service.claim(
						{
							taskId: "example",
							claimant: "orchestrator",
							agent: "agent",
							sessionId: "session-1",
							revision: inspected.revision,
						},
						root,
					),
				),
			),
		)
		await expect(
			runTestEffect(
				VcsMigrationService.pipe(
					Effect.flatMap((service) =>
						service.migrate("jj", root, { apply: true }),
					),
				),
			),
		).rejects.toThrow("is active")
	})

	test("blocks dirty workspaces", async () => {
		if (!Bun.which("jj")) return
		await Bun.write(join(root, "tasks/example/code/agency/DIRTY.md"), "dirty\n")
		await expect(
			runTestEffect(
				VcsMigrationService.pipe(
					Effect.flatMap((service) =>
						service.migrate("jj", root, { apply: true }),
					),
				),
			),
		).rejects.toThrow("must be clean")
	})

	test("blocks jj-only heads when migrating to Git", async () => {
		if (!Bun.which("jj")) return
		await runTestEffect(
			VcsMigrationService.pipe(
				Effect.flatMap((service) =>
					service.migrate("jj", root, { apply: true }),
				),
			),
		)
		const repository = join(root, "repos/agency")
		await run(["jj", "-R", repository, "new", "main", "-m", "hidden head"])
		await run(["jj", "-R", repository, "new", "main"])

		await expect(
			runTestEffect(
				VcsMigrationService.pipe(
					Effect.flatMap((service) =>
						service.migrate("git", root, { apply: true }),
					),
				),
			),
		).rejects.toThrow("jj-only heads")
	})
})
