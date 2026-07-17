import { afterEach, beforeEach, describe, expect, test } from "bun:test"
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

	test("requires a supported work item type", async () => {
		await expect(
			runTestEffect(archive({ args: [], cwd: root, silent: true })),
		).rejects.toThrow("Available: list, show, epic, task, phase")
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
