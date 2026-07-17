import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { cleanupTempDir, createTempDir, runTestEffect } from "./test-utils"
import { getWorkViews } from "./work-view"

const write = async (root: string, path: string, content: string) => {
	const fullPath = join(root, path)
	await mkdir(dirname(fullPath), { recursive: true })
	await Bun.write(fullPath, content)
}

describe("work views", () => {
	let root: string

	beforeEach(async () => {
		root = await createTempDir()
		await write(root, "agency.json", '{"version":2}\n')
		await mkdir(join(root, "repos/agency"), { recursive: true })
		await write(
			root,
			"epics/delivery/EPIC.md",
			`---
ticketUrl: https://example.com/delivery
repos:
  - repo: agency
    ref: main
tasks:
  - id: zeta
  - id: alpha
---
`,
		)
		await write(
			root,
			"tasks/zeta/TASK.md",
			`---
ticketUrl: null
epic: delivery
phases:
  - id: verify
    dependsOn: [implement]
  - id: implement
---
`,
		)
		await write(
			root,
			"tasks/zeta/phases/verify/PHASE.md",
			`---
repo: agency
branch: feat/verify
base: main
pr: null
status: open
---
`,
		)
		await write(
			root,
			"tasks/zeta/phases/implement/PHASE.md",
			`---
repo: agency
branch: feat/implement
base: main
pr: https://github.com/example/agency/pull/1
status: dropped
---
`,
		)
		await mkdir(join(root, "tasks/zeta/phases/implement/code/agency"), {
			recursive: true,
		})
		await write(
			root,
			"tasks/alpha/TASK.md",
			`---
ticketUrl: null
epic: delivery
repo: agency
branch: feat/alpha
base: main
pr: null
status: open
---
`,
		)
	})

	afterEach(async () => cleanupTempDir(root))

	const views = (options: Record<string, unknown> = {}) =>
		runTestEffect(Effect.suspend(() => getWorkViews({ cwd: root, ...options })))

	test("uses declared graph order and exposes operational state", async () => {
		const result = await views()

		expect(result.taskRows.map((row) => row.id)).toEqual(["zeta", "alpha"])
		expect(result.phaseRows.map((row) => row.id)).toEqual([
			"verify",
			"implement",
		])
		expect(result.executionRows.map((row) => row.key)).toEqual([
			"zeta/verify",
			"zeta/implement",
			"alpha",
		])
		expect(result.phaseRows[0]).toMatchObject({
			parent: "zeta",
			status: "open",
			readiness: "blocked",
			repositories: "agency",
			branch: "feat/verify",
			pr: "absent",
			worktree: "absent",
		})
		expect(result.phaseRows[1]).toMatchObject({
			readiness: "terminal",
			pr: "present",
			worktree: "materialized",
		})
		expect(result.taskRows[0]).toMatchObject({
			parent: "delivery",
			branch: "multiple",
			pr: "1/2 present",
			worktree: "1/2 materialized",
		})
	})

	test("composes lifecycle, repository, readiness, and PR filters", async () => {
		expect(
			(await views({ statuses: ["dropped"] })).executionRows.map(
				(row) => row.key,
			),
		).toEqual(["zeta/implement"])
		expect(
			(await views({ repositories: ["agency"], blocked: true })).phaseRows.map(
				(row) => row.id,
			),
		).toEqual(["verify"])
		expect(
			(await views({ ready: true, pr: false })).executionRows.map(
				(row) => row.key,
			),
		).toEqual(["alpha"])
		expect((await views({ pr: true })).phaseRows.map((row) => row.id)).toEqual([
			"implement",
		])
	})
})
