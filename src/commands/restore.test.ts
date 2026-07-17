import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import {
	captureLogs,
	cleanupTempDir,
	createTempDir,
	runTestEffect,
} from "../test-utils"
import { archive } from "./archive"
import { restore } from "./restore"
import { task } from "./task"

describe("restore command", () => {
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
		if (initialized.exitCode !== 0)
			throw new Error(new TextDecoder().decode(initialized.stderr))
		await runTestEffect(
			task({
				subcommand: "create",
				args: ["example"],
				repo: "agency",
				branch: "task/example",
				base: "main",
				cwd: root,
				silent: true,
			}),
		)
		await runTestEffect(
			archive({ type: "task", args: ["example"], cwd: root, silent: true }),
		)
	})

	afterEach(async () => cleanupTempDir(root))

	test("dry-runs then restores an archived task", async () => {
		const preview = await captureLogs(() =>
			runTestEffect(
				restore({
					type: "task",
					args: ["example"],
					cwd: root,
					dryRun: true,
				}),
			),
		)
		expect(preview[0]).toContain("Would restore task 'example'")
		expect(await Bun.file(join(root, "tasks/example/TASK.md")).exists()).toBe(
			false,
		)

		const logs = await captureLogs(() =>
			runTestEffect(
				restore({ type: "task", args: ["example"], cwd: root, json: true }),
			),
		)
		expect(JSON.parse(logs[0]!)).toMatchObject({
			operation: "restore",
			kind: "task",
			id: "example",
			dryRun: false,
		})
		expect(await Bun.file(join(root, "tasks/example/TASK.md")).exists()).toBe(
			true,
		)
	})

	test("lists and shows archived work", async () => {
		const listed = await captureLogs(() =>
			runTestEffect(
				archive({
					type: "list",
					args: [],
					kinds: ["task"],
					repositories: ["agency"],
					cwd: root,
				}),
			),
		)
		expect(listed).toEqual(["task\texample"])

		const shown = await captureLogs(() =>
			runTestEffect(
				archive({ type: "show", args: ["task", "example"], cwd: root }),
			),
		)
		expect(shown[0]).toContain("# Example")
	})
})
