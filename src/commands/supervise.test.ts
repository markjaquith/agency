import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { cleanupTempDir, createTempDir, runTestEffect } from "../test-utils"
import { supervise } from "./supervise"

let root: string

beforeEach(async () => {
	root = await createTempDir()
	await Bun.write(join(root, "agency.json"), '{"version":2}\n')
})

afterEach(() => cleanupTempDir(root))

describe("agency supervise", () => {
	test("requires an interactive terminal", async () => {
		await expect(
			runTestEffect(supervise({ inputAllowed: false })),
		).rejects.toThrow("agency supervise requires an interactive terminal")
	})

	test("opens act's Supervise tab, which needs the built-in TUI", async () => {
		// Tests have no TTY, so act cannot open its interactive session.
		await expect(
			runTestEffect(supervise({ cwd: root, inputAllowed: true })),
		).rejects.toThrow("agency supervise requires an interactive terminal")
	})
})
