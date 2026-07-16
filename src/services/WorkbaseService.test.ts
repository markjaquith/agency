import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { cleanupTempDir, createTempDir, runTestEffect } from "../test-utils"
import { managedWorkbaseAgents } from "../workbase/agents-file"
import { managedWorkbaseOpencode } from "../workbase/opencode-file"
import { WorkbaseService } from "./WorkbaseService"

const write = async (root: string, path: string, content: string) => {
	const fullPath = join(root, path)
	await mkdir(dirname(fullPath), { recursive: true })
	await Bun.write(fullPath, content)
}

const managedAgents = (body: string) => {
	const checksum = createHash("sha256").update(body).digest("hex")
	return `<!-- agency-managed: sha256=${checksum} -->\n\n${body}`
}

const managedOpencode = (body: string) => {
	const checksum = createHash("sha256").update(body).digest("hex")
	return `// agency-managed: sha256=${checksum}\n\n${body}`
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
		expect(await Bun.file(join(root, "AGENTS.md")).text()).toBe(
			managedWorkbaseAgents,
		)
		expect(await Bun.file(join(root, ".opencode/opencode.jsonc")).text()).toBe(
			managedWorkbaseOpencode,
		)
	})

	test("preserves an unmanaged workbase OpenCode config", async () => {
		await write(root, "agency.json", '{"version":2}\n')
		await write(root, ".opencode/opencode.jsonc", '{"model":"test/model"}\n')

		await runTestEffect(
			WorkbaseService.pipe(Effect.flatMap((service) => service.discover(root))),
		)

		expect(await Bun.file(join(root, ".opencode/opencode.jsonc")).text()).toBe(
			'{"model":"test/model"}\n',
		)
	})

	test("does not override an existing JSON OpenCode config", async () => {
		await write(root, "agency.json", '{"version":2}\n')
		await write(root, ".opencode/opencode.json", '{"model":"test/model"}\n')

		await runTestEffect(
			WorkbaseService.pipe(Effect.flatMap((service) => service.discover(root))),
		)

		expect(
			await Bun.file(join(root, ".opencode/opencode.jsonc")).exists(),
		).toBe(false)
	})

	test("updates an unmodified managed workbase OpenCode config", async () => {
		await write(root, "agency.json", '{"version":2}\n')
		await write(
			root,
			".opencode/opencode.jsonc",
			managedOpencode('{"references":{}}\n'),
		)

		await runTestEffect(
			WorkbaseService.pipe(Effect.flatMap((service) => service.discover(root))),
		)

		expect(await Bun.file(join(root, ".opencode/opencode.jsonc")).text()).toBe(
			managedWorkbaseOpencode,
		)
	})

	test("preserves a modified managed workbase OpenCode config", async () => {
		await write(root, "agency.json", '{"version":2}\n')
		const content = `${managedOpencode('{"references":{}}\n')}\n// User edit\n`
		await write(root, ".opencode/opencode.jsonc", content)

		await runTestEffect(
			WorkbaseService.pipe(Effect.flatMap((service) => service.discover(root))),
		)

		expect(await Bun.file(join(root, ".opencode/opencode.jsonc")).text()).toBe(
			content,
		)
	})

	test("preserves an unmanaged workbase AGENTS.md", async () => {
		await write(root, "agency.json", '{"version":2}\n')
		await write(root, "AGENTS.md", "# Custom instructions\n")

		await runTestEffect(
			WorkbaseService.pipe(Effect.flatMap((service) => service.discover(root))),
		)

		expect(await Bun.file(join(root, "AGENTS.md")).text()).toBe(
			"# Custom instructions\n",
		)
	})

	test("updates an unmodified managed workbase AGENTS.md", async () => {
		await write(root, "agency.json", '{"version":2}\n')
		await write(
			root,
			"AGENTS.md",
			managedAgents("# Previous Agency instructions\n"),
		)

		await runTestEffect(
			WorkbaseService.pipe(Effect.flatMap((service) => service.discover(root))),
		)

		expect(await Bun.file(join(root, "AGENTS.md")).text()).toBe(
			managedWorkbaseAgents,
		)
	})

	test("preserves a modified managed workbase AGENTS.md", async () => {
		await write(root, "agency.json", '{"version":2}\n')
		const content = `${managedAgents("# Previous Agency instructions\n")}\nUser edit\n`
		await write(root, "AGENTS.md", content)

		await runTestEffect(
			WorkbaseService.pipe(Effect.flatMap((service) => service.discover(root))),
		)

		expect(await Bun.file(join(root, "AGENTS.md")).text()).toBe(content)
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
  - repo: agency
    ref: main
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
  - repo: effect
    ref: main
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
  - repo: missing
    ref: main
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
  - repo: agency
    ref: main
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

	test("reports duplicate writable branch ownership", async () => {
		await write(root, "agency.json", '{"version":2}\n')
		await mkdir(join(root, "repos/agency"), { recursive: true })
		for (const id of ["first", "second"]) {
			await write(
				root,
				`tasks/${id}/TASK.md`,
				`---
ticketUrl: https://example.com/tasks/${id}
repo: agency
branch: task/shared
base: main
pr: null
---
`,
			)
		}

		const report = await runTestEffect(
			WorkbaseService.pipe(Effect.flatMap((service) => service.validate(root))),
		)

		expect(report.valid).toBe(false)
		expect(report.issues).toContainEqual({
			path: "tasks/second/TASK.md",
			message:
				"Writable branch 'task/shared' for repository 'agency' is also owned by tasks/first/TASK.md",
		})
	})

	test("reports high-risk structural validation failures", async () => {
		const fixtures: readonly {
			name: string
			files: Readonly<Record<string, string>>
			directories?: readonly string[]
			expected: readonly string[]
		}[] = [
			{
				name: "missing-documents",
				files: {},
				directories: [
					"epics/missing-epic",
					"tasks/missing-task",
					"tasks/missing-task/phases/missing-phase",
				],
				expected: [
					"epics/missing-epic/EPIC.md: Required document is missing",
					"tasks/missing-task/TASK.md: Required document is missing",
					"tasks/missing-task/phases/missing-phase/PHASE.md: Required document is missing",
				],
			},
			{
				name: "duplicates",
				files: {
					"epics/duplicate/EPIC.md": `---
ticketUrl: https://example.com/epics/duplicate
repos:
  - repo: agency
    ref: main
  - repo: agency
    ref: release
tasks:
  - id: child
  - id: child
---
`,
					"tasks/child/TASK.md": `---
ticketUrl: https://example.com/tasks/child
epic: duplicate
phases:
  - id: implementation
  - id: implementation
---
`,
					"tasks/child/phases/implementation/PHASE.md": `---
repo: agency
branch: task/duplicate
base: main
pr: null
---
`,
				},
				expected: [
					"Repository references must be unique",
					"Epic task IDs must be unique",
					"Task phase IDs must be unique",
				],
			},
			{
				name: "backlinks",
				files: {
					"epics/parent/EPIC.md": `---
ticketUrl: https://example.com/epics/parent
repos:
  - repo: agency
    ref: main
tasks:
  - id: missing-backlink
---
`,
					"tasks/missing-backlink/TASK.md": `---
ticketUrl: https://example.com/tasks/missing-backlink
repo: agency
branch: task/missing-backlink
base: main
pr: null
---
`,
					"tasks/unlisted/TASK.md": `---
ticketUrl: https://example.com/tasks/unlisted
epic: parent
repo: agency
branch: task/unlisted
base: main
pr: null
---
`,
				},
				expected: [
					"Task must reference parent epic 'parent'",
					"Epic does not list child task 'unlisted'",
				],
			},
			{
				name: "dependency-cycles",
				files: {
					"epics/cycles/EPIC.md": `---
ticketUrl: https://example.com/epics/cycles
repos:
  - repo: agency
    ref: main
tasks:
  - id: first
    dependsOn: [second]
  - id: second
    dependsOn: [first]
---
`,
					"tasks/first/TASK.md": `---
ticketUrl: https://example.com/tasks/first
epic: cycles
phases:
  - id: contract
    dependsOn: [delivery]
  - id: delivery
    dependsOn: [contract]
---
`,
					"tasks/first/phases/contract/PHASE.md": `---
repo: agency
branch: task/contract
base: main
pr: null
---
`,
					"tasks/first/phases/delivery/PHASE.md": `---
repo: agency
branch: task/delivery
base: main
pr: null
---
`,
					"tasks/second/TASK.md": `---
ticketUrl: https://example.com/tasks/second
epic: cycles
repo: agency
branch: task/second
base: main
pr: null
---
`,
				},
				expected: [
					"Task dependency cycle includes 'first'",
					"Phase dependency cycle includes 'contract'",
				],
			},
			{
				name: "phase-layout",
				files: {
					"tasks/multi/TASK.md": `---
ticketUrl: https://example.com/tasks/multi
phases:
  - id: listed
---
`,
					"tasks/multi/phases/listed/PHASE.md": `---
repo: agency
branch: task/listed
base: main
pr: null
---
`,
					"tasks/multi/phases/unlisted/PHASE.md": `---
repo: agency
branch: task/unlisted
base: main
pr: null
---
`,
					"tasks/single/TASK.md": `---
ticketUrl: https://example.com/tasks/single
repo: agency
branch: task/single
base: main
pr: null
---
`,
					"tasks/single/phases/unexpected/PHASE.md": `---
repo: agency
branch: task/unexpected
base: main
pr: null
---
`,
				},
				expected: [
					"Unlisted phase 'unlisted'",
					"Single-phase task cannot contain phase directories",
				],
			},
		]

		for (const fixture of fixtures) {
			const fixtureRoot = join(root, fixture.name)
			await write(fixtureRoot, "agency.json", '{"version":2}\n')
			await mkdir(join(fixtureRoot, "repos/agency"), { recursive: true })
			for (const directory of fixture.directories ?? []) {
				await mkdir(join(fixtureRoot, directory), { recursive: true })
			}
			for (const [path, content] of Object.entries(fixture.files)) {
				await write(fixtureRoot, path, content)
			}

			const report = await runTestEffect(
				WorkbaseService.pipe(
					Effect.flatMap((service) => service.validate(fixtureRoot)),
				),
			)
			const messages = report.issues
				.map((issue) => `${issue.path}: ${issue.message}`)
				.join("\n")
			expect(report.valid, fixture.name).toBe(false)
			for (const expected of fixture.expected) {
				expect(messages, fixture.name).toContain(expected)
			}
		}
	})
})
