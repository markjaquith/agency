import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import {
	captureLogs,
	cleanupTempDir,
	createTempDir,
	runTestEffect,
} from "../test-utils"
import { status } from "./status"

describe("status command", () => {
	let root: string

	beforeEach(async () => {
		root = await createTempDir()
		await Bun.write(join(root, "agency.json"), '{"version":2}\n')
		await mkdir(join(root, "repos/agency"), { recursive: true })
	})

	afterEach(async () => cleanupTempDir(root))

	test("outputs status and repository metadata as JSON", async () => {
		const logs = await captureLogs(() =>
			runTestEffect(status({ cwd: root, json: true })),
		)
		const output = JSON.parse(logs[0]!)

		expect(output).toMatchObject({
			root,
			issues: [],
			epicCount: 0,
			taskCount: 0,
			phaseCount: 0,
			valid: true,
		})
		expect(output.repositories).toEqual([
			{
				alias: "agency",
				path: join(root, "repos/agency"),
				kind: "repository",
				remote: null,
				target: null,
			},
		])
	})
})
