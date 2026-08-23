import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import {
	captureLogs,
	cleanupTempDir,
	createTempDir,
	runTestEffect,
} from "../test-utils"
import { archive } from "./archive"
import { task } from "./task"

describe("archive command", () => {
	let root: string

	beforeEach(async () => {
		root = await createTempDir()
		await Bun.write(join(root, "agency.json"), '{"version":2}\n')
		const initialized = Bun.spawnSync([
			"git",
			"init",
			"--bare",
			join(root, "repos/agency"),
		])
		if (initialized.exitCode !== 0) {
			throw new Error(new TextDecoder().decode(initialized.stderr))
		}
		await runTestEffect(
			task({
				subcommand: "create",
				args: ["example"],
				ticketUrl: "https://example.com/task",
				repo: "agency",
				branch: "task/example",
				base: "main",
				cwd: root,
				silent: true,
			}),
		)
		await runTestEffect(
			task({
				subcommand: "status",
				args: ["example", "dropped"],
				cwd: root,
				silent: true,
			}),
		)
	})

	afterEach(async () => cleanupTempDir(root))

	test("archives a task and outputs the result as JSON", async () => {
		const logs = await captureLogs(() =>
			runTestEffect(
				archive({
					type: "task",
					args: ["example"],
					cwd: root,
					json: true,
				}),
			),
		)

		expect(JSON.parse(logs[0]!)).toMatchObject({
			operation: "archive",
			kind: "task",
			id: "example",
			path: join(root, "archive/tasks/example"),
			affectedPaths: [join(root, "archive/tasks/example")],
			removedWorktrees: [],
			dryRun: false,
		})
	})

	test("preflights an archive without moving the task", async () => {
		const logs = await captureLogs(() =>
			runTestEffect(
				archive({
					type: "task",
					args: ["example"],
					cwd: root,
					dryRun: true,
					json: true,
				}),
			),
		)

		expect(JSON.parse(logs[0]!).dryRun).toBe(true)
		expect(await Bun.file(join(root, "tasks/example/TASK.md")).exists()).toBe(
			true,
		)
		expect(await Bun.file(join(root, "archive/tasks/example")).exists()).toBe(
			false,
		)
	})

	test("infers a task from a filesystem path", async () => {
		const logs = await captureLogs(() =>
			runTestEffect(
				archive({
					args: ["."],
					cwd: join(root, "tasks/example"),
					dryRun: true,
					json: true,
				}),
			),
		)

		expect(JSON.parse(logs[0]!)).toMatchObject({
			operation: "archive",
			kind: "task",
			id: "example",
			dryRun: true,
		})
	})

	test("infers an epic from a filesystem path", async () => {
		const directory = join(root, "epics/delivery")
		await mkdir(directory, { recursive: true })
		await Bun.write(
			join(directory, "EPIC.md"),
			`---
ticketUrl: https://example.com/epic
repos:
  - repo: agency
    ref: main
tasks: []
---

# Delivery
`,
		)
		const logs = await captureLogs(() =>
			runTestEffect(
				archive({ args: ["."], cwd: directory, dryRun: true, json: true }),
			),
		)

		expect(JSON.parse(logs[0]!)).toMatchObject({
			operation: "archive",
			kind: "epic",
			id: "delivery",
			dryRun: true,
		})
	})

	test("rejects ambiguous and unsupported archive paths", async () => {
		await expect(
			runTestEffect(archive({ args: ["."], cwd: root, silent: true })),
		).rejects.toThrow("Archive path is ambiguous")
		await expect(
			runTestEffect(
				archive({ args: ["repos/agency"], cwd: root, silent: true }),
			),
		).rejects.toThrow("Archive path must be within an active epic or task")

		const phaseDirectory = join(root, "tasks/example/phases/build")
		await mkdir(phaseDirectory, { recursive: true })
		await expect(
			runTestEffect(
				archive({ args: ["."], cwd: phaseDirectory, silent: true }),
			),
		).rejects.toThrow("Archive path identifies a phase")
	})

	test("reports an already archived task", async () => {
		await runTestEffect(
			archive({ type: "task", args: ["example"], cwd: root, silent: true }),
		)

		await expect(
			runTestEffect(
				archive({
					type: "task",
					args: ["example"],
					cwd: root,
					silent: true,
				}),
			),
		).rejects.toThrow("Task 'example' is already archived")
	})

	test("outputs one deterministic bulk archive object and a concise human summary", async () => {
		const jsonLogs = await captureLogs(() =>
			runTestEffect(
				archive({
					type: "tasks",
					args: [],
					cwd: root,
					dryRun: true,
					json: true,
				}),
			),
		)
		expect(jsonLogs).toHaveLength(1)
		expect(JSON.parse(jsonLogs[0]!)).toMatchObject({
			operation: "archive",
			kind: "tasks",
			dryRun: true,
			tasks: [{ id: "example", disposition: "planned" }],
		})

		const humanLogs = await captureLogs(() =>
			runTestEffect(
				archive({ type: "tasks", args: [], cwd: root, dryRun: true }),
			),
		)
		expect(humanLogs).toEqual([
			"Would archive 1 task: example\nSkipped 0 tasks",
		])
	})

	test("requires a supported work item type", async () => {
		await expect(
			runTestEffect(archive({ args: [], cwd: root, silent: true })),
		).rejects.toThrow(
			"Provide a path or use: list, show, epic, task, tasks, phase",
		)
	})

	test("rejects an extra archive show identifier", async () => {
		await runTestEffect(
			archive({ type: "task", args: ["example"], cwd: root, silent: true }),
		)
		await expect(
			runTestEffect(
				archive({
					type: "show",
					args: ["task", "example", "extra"],
					cwd: root,
					silent: true,
				}),
			),
		).rejects.toThrow("Usage: agency archive show")
	})
})
