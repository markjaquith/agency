import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { stat } from "node:fs/promises"
import { join } from "node:path"
import {
	captureLogs,
	cleanupTempDir,
	createTempDir,
	runTestEffect,
} from "../test-utils"
import { init } from "./init"

describe("init command", () => {
	let parent: string

	beforeEach(async () => {
		parent = await createTempDir()
	})

	afterEach(async () => {
		await cleanupTempDir(parent)
	})

	test("creates a workbase and required directories", async () => {
		const root = join(parent, "workbase")
		await runTestEffect(init({ path: root, silent: true }))

		expect(await Bun.file(join(root, "agency.json")).json()).toEqual({
			version: 2,
		})
		for (const directory of ["repos", "epics", "tasks"]) {
			expect((await stat(join(root, directory))).isDirectory()).toBe(true)
		}
		expect(await Bun.file(join(root, ".gitignore")).text()).toBe(
			"/repos/\n/tasks/*/code/\n/tasks/*/phases/*/code/\n",
		)
		expect(await Bun.file(join(root, "AGENTS.md")).text()).toContain(
			"# Agency Workbase",
		)
	})

	test("preserves existing gitignore entries", async () => {
		await Bun.write(join(parent, ".gitignore"), "custom\n")
		await runTestEffect(init({ path: parent, silent: true }))

		expect(await Bun.file(join(parent, ".gitignore")).text()).toStartWith(
			"custom\n",
		)
	})

	test("outputs the initialized workbase as JSON", async () => {
		const root = join(parent, "json-workbase")
		const logs = await captureLogs(() =>
			runTestEffect(init({ path: root, json: true })),
		)

		expect(JSON.parse(logs[0]!)).toEqual({ root })
	})

	test("rejects an existing Agency configuration", async () => {
		await Bun.write(join(parent, "agency.json"), '{"version":2}\n')

		await expect(
			runTestEffect(init({ path: parent, silent: true })),
		).rejects.toThrow("already exists")
	})
})
