import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import {
	captureLogs,
	cleanupTempDir,
	createTempDir,
	runTestEffect,
} from "../test-utils"
import { validate } from "./validate"

describe("validate command", () => {
	let root: string

	beforeEach(async () => {
		root = await createTempDir()
		await Bun.write(join(root, "agency.json"), '{"version":2}\n')
		await mkdir(join(root, "repos/agency"), { recursive: true })
		await mkdir(join(root, "tasks/example"), { recursive: true })
	})

	afterEach(async () => {
		await cleanupTempDir(root)
	})

	test("succeeds for a valid workbase", async () => {
		await Bun.write(
			join(root, "tasks/example/TASK.md"),
			`---
ticketUrl: https://example.com/tasks/example
repo: agency
branch: task/example
base: main
pr: null
---

# Example
`,
		)

		await expect(
			runTestEffect(validate({ cwd: root, silent: true })),
		).resolves.toBeUndefined()
	})

	test("outputs the validation report as JSON", async () => {
		await Bun.write(
			join(root, "tasks/example/TASK.md"),
			`---
ticketUrl: https://example.com/tasks/example
repo: agency
branch: task/example
base: main
pr: null
---
`,
		)
		const logs = await captureLogs(() =>
			runTestEffect(validate({ cwd: root, json: true })),
		)

		expect(JSON.parse(logs[0]!)).toEqual({
			root,
			issues: [],
			epicCount: 0,
			taskCount: 1,
			phaseCount: 0,
			valid: true,
		})
	})

	test("fails with document diagnostics", async () => {
		await Bun.write(
			join(root, "tasks/example/TASK.md"),
			`---
ticketUrl: https://example.com/tasks/example
repo: missing
branch: task/example
base: main
pr: null
---

# Example
`,
		)

		await expect(
			runTestEffect(validate({ cwd: root, silent: true })),
		).rejects.toThrow("Unknown repository alias 'missing'")
	})
})
