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
import { task } from "./task"

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

	test("renders and filters the execution dashboard", async () => {
		await runTestEffect(
			task({
				subcommand: "create",
				args: ["example"],
				repo: "agency",
				branch: "feat/example",
				base: "main",
				cwd: root,
				silent: true,
			}),
		)
		await runTestEffect(
			task({
				subcommand: "create",
				args: ["finished"],
				repo: "agency",
				branch: "feat/finished",
				base: "main",
				cwd: root,
				silent: true,
			}),
		)
		await runTestEffect(
			task({
				subcommand: "status",
				args: ["finished", "done"],
				cwd: root,
				silent: true,
			}),
		)

		const logs = await captureLogs(() =>
			runTestEffect(
				status({ cwd: root, repositories: ["agency"], ready: true, pr: false }),
			),
		)
		expect(logs).toContain("Repositories: 1")
		expect(logs.at(-1)).toContain(
			"KIND  WORK     PARENT  STATUS  READINESS  REPOSITORIES  BRANCH",
		)
		expect(logs.at(-1)).toContain(
			"task  example  -       open    ready      agency        feat/example  absent  absent",
		)
		expect(logs.at(-1)).not.toContain("finished")
	})

	test("reports validation issues without requiring a decodable graph", async () => {
		await mkdir(join(root, "tasks/broken"), { recursive: true })
		await Bun.write(
			join(root, "tasks/broken/TASK.md"),
			"---\nrepo: agency\nstatus: invalid\n---\n",
		)

		const logs = await captureLogs(() =>
			runTestEffect(status({ cwd: root, json: true })),
		)
		const output = JSON.parse(logs[0]!)
		expect(output.valid).toBe(false)
		expect(output.issues.length).toBeGreaterThan(0)
		expect(output.work).toEqual([])
	})
})
