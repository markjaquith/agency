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
		expect(await Bun.file(join(root, "AGENTS.md")).exists()).toBe(false)
		expect(await Bun.file(join(root, ".agency/AGENTS.md")).exists()).toBe(true)
		const opencode = await Bun.file(
			join(root, ".opencode/opencode.jsonc"),
		).text()
		const config = JSON.parse(opencode.slice(opencode.indexOf("\n\n") + 2))
		expect(config.instructions).toEqual([".agency/AGENTS.md"])
		expect(config.agent.agency).toMatchObject({
			description: expect.stringContaining("Agency workbase orchestration"),
			mode: "subagent",
			prompt: expect.stringContaining("agency context . --json"),
		})
		expect(config.agent.plan).toEqual({ disable: true })
		expect(config.agent["agency-plan"]).toMatchObject({
			mode: "primary",
			permission: {
				bash: {
					"agency *": "allow",
				},
				edit: {
					"*": "deny",
					"tasks/*/TASK.md": "allow",
					"tasks/*/phases/*/PHASE.md": "allow",
					"epics/*/EPIC.md": "allow",
				},
			},
		})
		expect(config.references).toEqual({
			workbase: expect.objectContaining({ path: ".." }),
		})
		expect(config.permission).toBeUndefined()
		const command = await Bun.file(
			join(root, ".opencode/command/agency.md"),
		).text()
		expect(command).toContain("Workflow: `$1`")
		expect(command).toContain("Optional target: `$2`")
		const plugin = await Bun.file(
			join(root, ".opencode/plugin/agency-repository-skills.ts"),
		).text()
		expect(plugin).toContain("AGENCY_WRITABLE_CHECKOUT")
		expect(plugin).toContain("config.skills.paths")
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
