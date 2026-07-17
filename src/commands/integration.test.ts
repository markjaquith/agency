import { afterEach, beforeEach, describe, expect, test } from "bun:test"
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
				{ name: "opencode", state: "missing" },
			],
		})
	})

	test("explicitly synchronizes integration files", async () => {
		const logs = await captureLogs(() =>
			runTestEffect(integration({ subcommand: "sync", cwd: root, json: true })),
		)

		expect(JSON.parse(logs[0]!).files).toMatchObject([
			{ name: "agents", state: "managed", changed: true },
			{ name: "opencode", state: "managed", changed: true },
		])
		expect(await Bun.file(join(root, "AGENTS.md")).exists()).toBe(true)
		expect(
			await Bun.file(join(root, ".opencode/opencode.jsonc")).exists(),
		).toBe(true)
	})
})
