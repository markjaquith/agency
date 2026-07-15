import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { cleanupTempDir, createTempDir, runTestEffect } from "../test-utils"
import { WorkbaseService } from "./WorkbaseService"

const write = async (root: string, path: string, content: string) => {
	const fullPath = join(root, path)
	await mkdir(dirname(fullPath), { recursive: true })
	await Bun.write(fullPath, content)
}

describe("WorkbaseService", () => {
	let root: string

	beforeEach(async () => {
		root = await createTempDir()
	})

	afterEach(async () => {
		await cleanupTempDir(root)
	})

	test("discovers a workbase from a nested directory", async () => {
		await write(root, "agency.json", '{"version":2}\n')
		await mkdir(join(root, "nested/repository/src"), { recursive: true })

		const discovered = await runTestEffect(
			WorkbaseService.pipe(
				Effect.flatMap((service) =>
					service.discover(join(root, "nested/repository/src")),
				),
			),
		)

		expect(discovered).toBe(root)
	})

	test("rejects an invalid worktree command template", async () => {
		await write(
			root,
			"agency.json",
			JSON.stringify({
				version: 2,
				worktreeCreateCommand: ["tool", "{repo}"],
			}),
		)

		await expect(
			runTestEffect(
				WorkbaseService.pipe(
					Effect.flatMap((service) => service.discover(root)),
				),
			),
		).rejects.toThrow("{worktree}")
	})

	test("validates a workbase with an epic and multi-phase task", async () => {
		await write(root, "agency.json", '{"version":2}\n')
		await mkdir(join(root, "repos/agency"), { recursive: true })
		await mkdir(join(root, "repos/effect"), { recursive: true })
		await write(
			root,
			"epics/example/EPIC.md",
			`---
ticketUrl: https://example.com/epics/example
repos:
  - agency
tasks:
  - id: example-task
---

# Example
`,
		)
		await write(
			root,
			"tasks/example-task/TASK.md",
			`---
ticketUrl: https://example.com/tasks/example
epic: example
phases:
  - id: implementation
---

# Example task
`,
		)
		await write(
			root,
			"tasks/example-task/phases/implementation/PHASE.md",
			`---
repo: agency
repos:
  - effect
branch: task/example
base: main
pr: null
---

# Implementation
`,
		)

		const report = await runTestEffect(
			WorkbaseService.pipe(Effect.flatMap((service) => service.validate(root))),
		)

		expect(report.valid).toBe(true)
		expect(report.issues).toEqual([])
		expect(report.epicCount).toBe(1)
		expect(report.taskCount).toBe(1)
		expect(report.phaseCount).toBe(1)
	})

	test("reports schema, alias, backlink, and dependency errors", async () => {
		await write(root, "agency.json", '{"version":2}\n')
		await mkdir(join(root, "repos/agency"), { recursive: true })
		await write(
			root,
			"epics/example/EPIC.md",
			`---
ticketUrl: https://example.com/epics/example
repos:
  - missing
tasks:
  - id: example-task
    dependsOn:
      - absent-task
---

# Example
`,
		)
		await write(
			root,
			"tasks/example-task/TASK.md",
			`---
ticketUrl: https://example.com/tasks/example
repo: agency
repos:
  - agency
branch: task/example
base: main
pr: null
---

# Example task
`,
		)
		await write(
			root,
			"tasks/bad-schema/TASK.md",
			`---
ticketUrl: https://example.com/tasks/bad-schema
repo: agency
branch: task/bad-schema
base: main
pr: not-a-url
---

# Bad schema
`,
		)

		const report = await runTestEffect(
			WorkbaseService.pipe(Effect.flatMap((service) => service.validate(root))),
		)

		expect(report.valid).toBe(false)
		expect(report.issues.map((issue) => issue.message).join("\n")).toContain(
			"Unknown repository alias 'missing'",
		)
		expect(report.issues.map((issue) => issue.message).join("\n")).toContain(
			"Unknown task dependency 'absent-task'",
		)
		expect(report.issues.map((issue) => issue.message).join("\n")).toContain(
			"Task must reference parent epic 'example'",
		)
		expect(report.issues.map((issue) => issue.message).join("\n")).toContain(
			"Repository 'agency' cannot also be a reference",
		)
		expect(
			report.issues.some(
				(issue) => issue.path.endsWith("bad-schema/TASK.md") && issue.message,
			),
		).toBe(true)
		expect(report.issues.some((issue) => issue.path.endsWith("TASK.md"))).toBe(
			true,
		)
	})
})
