import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import {
	captureLogs,
	cleanupTempDir,
	createTempDir,
	runTestEffect,
} from "../test-utils"
import { integration } from "./integration"

describe("integration command", () => {
	let root: string

	beforeEach(async () => {
		root = await createTempDir()
		await Bun.write(join(root, "agency.json"), '{"version":2}\n')
	})

	afterEach(async () => cleanupTempDir(root))

	test("reports integration status as JSON", async () => {
		const logs = await captureLogs(() =>
			runTestEffect(
				integration({ subcommand: "status", cwd: root, json: true }),
			),
		)

		expect(JSON.parse(logs[0]!)).toMatchObject({
			root,
			files: [
				{ name: "agents", state: "missing" },
				{
					name: "opencode",
					state: "missing",
					diagnostic: expect.stringContaining("cannot load"),
					remediation: expect.stringContaining("integration sync"),
				},
			],
		})
	})

	test("explains remediation for customized OpenCode config", async () => {
		await mkdir(join(root, ".opencode"))
		await Bun.write(
			join(root, ".opencode", "opencode.json"),
			'{"model":"test/model"}\n',
		)
		const logs = await captureLogs(() =>
			runTestEffect(integration({ subcommand: "status", cwd: root })),
		)

		expect(logs.join("\n")).toContain("cannot guarantee its instructions")
		expect(logs.join("\n")).toContain("global config")
	})

	test("explicitly synchronizes integration files", async () => {
		const logs = await captureLogs(() =>
			runTestEffect(integration({ subcommand: "sync", cwd: root, json: true })),
		)

		expect(JSON.parse(logs[0]!).files).toMatchObject([
			{ name: "agents", state: "managed", changed: true },
			{ name: "opencode", state: "managed", changed: true },
		])
		expect(await Bun.file(join(root, "AGENTS.md")).exists()).toBe(false)
		expect(await Bun.file(join(root, ".agency/AGENTS.md")).exists()).toBe(true)
		expect(
			await Bun.file(join(root, ".opencode/opencode.jsonc")).exists(),
		).toBe(true)
	})
})
