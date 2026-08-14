import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { chmod, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { TaskService } from "../services/TaskService"
import {
	captureLogs,
	cleanupTempDir,
	createTempDir,
	runTestEffect,
} from "../test-utils"
import type { Progress } from "../utils/progress"
import { sync } from "./sync"

const git = async (args: string[], cwd: string) => {
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

describe("sync command", () => {
	let root: string

	beforeEach(async () => {
		root = await createTempDir()
		const source = join(root, "source")
		await mkdir(source)
		await git(["init", "--initial-branch=main"], source)
		await git(["config", "user.email", "test@example.com"], source)
		await git(["config", "user.name", "Test"], source)
		await Bun.write(join(source, "README.md"), "example\n")
		await git(["add", "README.md"], source)
		await git(["-c", "commit.gpgsign=false", "commit", "-m", "initial"], source)
		await mkdir(join(root, "repos"))
		await git(["clone", "--bare", source, join(root, "repos/agency")], root)
		await Bun.write(join(root, "agency.json"), '{"version":2}\n')
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "example",
							ticketUrl: null,
							repo: "agency",
							branch: "task/example",
							base: "main",
						},
						root,
					),
				),
			),
		)
	})

	afterEach(async () => cleanupTempDir(root))

	test("applies safe reconciliation by default", async () => {
		const logs = await captureLogs(() => runTestEffect(sync({ cwd: root })))

		expect(
			await Bun.file(join(root, "tasks/example/code/agency/README.md")).text(),
		).toBe("example\n")
		expect(logs).toContainEqual(
			expect.stringContaining("Applied materialize-workspace 'task:example'"),
		)
		expect(() => JSON.parse(logs.join("\n"))).toThrow()
	})

	test("keeps explicit dry-run observational", async () => {
		await runTestEffect(sync({ cwd: root, dryRun: true, silent: true }))

		expect(
			await Bun.file(
				join(root, "tasks/example/code/agency/README.md"),
			).exists(),
		).toBe(false)
	})

	test("scopes reconciliation to one task", async () => {
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "second",
							ticketUrl: null,
							repo: "agency",
							branch: "task/second",
							base: "main",
						},
						root,
					),
				),
			),
		)

		const logs = await captureLogs(() =>
			runTestEffect(sync({ cwd: root, taskId: "example", json: true })),
		)
		const result = JSON.parse(logs[0]!)
		expect(result.executions.map((execution: any) => execution.target)).toEqual(
			["task:example"],
		)
		expect(
			await Bun.file(
				join(root, "tasks/example/code/agency/README.md"),
			).exists(),
		).toBe(true)
		expect(
			await Bun.file(join(root, "tasks/second/code/agency/README.md")).exists(),
		).toBe(false)
	})

	test("preserves structured output behind --json", async () => {
		const logs = await captureLogs(() =>
			runTestEffect(sync({ cwd: root, dryRun: true, json: true })),
		)

		expect(logs).toHaveLength(1)
		expect(JSON.parse(logs[0]!)).toMatchObject({
			mode: "dry-run",
			changes: [
				expect.objectContaining({
					kind: "materialize-workspace",
					status: "planned",
				}),
			],
		})
	})

	test("groups repeated human-readable warnings by affected target", async () => {
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "second",
							ticketUrl: null,
							repo: "agency",
							branch: "task/second",
							base: "main",
						},
						root,
					),
				),
			),
		)
		const originalPath = process.env.PATH
		const bin = join(root, "bin")
		await mkdir(bin)
		await Bun.write(
			join(bin, "gh"),
			'#!/bin/sh\necho "provider unavailable" >&2\nexit 1\n',
		)
		await chmod(join(bin, "gh"), 0o755)
		process.env.PATH = `${bin}:${originalPath}`
		try {
			const logs = await captureLogs(() =>
				runTestEffect(sync({ cwd: root, dryRun: true })),
			)
			expect(
				logs.filter((line) => line.includes("provider unavailable")),
			).toEqual(["Warning 'task:example', 'task:second': provider unavailable"])
		} finally {
			process.env.PATH = originalPath
		}
	})

	test("reports human-readable progress without polluting JSON output", async () => {
		const updates: string[] = []
		const progress: Progress = {
			start: (message) => updates.push(`start:${message}`),
			succeed: (message) => updates.push(`succeed:${message}`),
			fail: (message) => updates.push(`fail:${message}`),
		}

		await captureLogs(() =>
			runTestEffect(sync({ cwd: root, silent: false }, progress)),
		)
		expect(updates).toEqual([
			"start:Validating workbase",
			"start:Inspected 1 repositories",
			"start:Queried pull requests 1/1 (task:example)",
			"start:Reconciled execution units 1/1 (task:example)",
			"succeed:Synchronized 1 execution units",
		])

		updates.length = 0
		await captureLogs(() =>
			runTestEffect(sync({ cwd: root, dryRun: true, json: true }, progress)),
		)
		expect(updates).toEqual([])
	})
})
