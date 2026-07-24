import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdir, realpath, rm, symlink } from "node:fs/promises"
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
		expect(await Bun.file(join(root, "AGENTS.md")).exists()).toBe(false)
		expect(
			await Bun.file(join(root, ".opencode/opencode.jsonc")).exists(),
		).toBe(false)
	})

	test("treats declared but missing repositories as valid aliases", async () => {
		await write(
			root,
			"agency.json",
			JSON.stringify({
				version: 2,
				repositories: {
					agency: { remote: "https://example.com/agency.git" },
				},
			}),
		)
		await write(
			root,
			"tasks/portable/TASK.md",
			`---
ticketUrl: null
repo: agency
branch: task/portable
base: main
pr: null
---
`,
		)

		const report = await runTestEffect(
			WorkbaseService.pipe(Effect.flatMap((service) => service.validate(root))),
		)

		expect(report.valid).toBe(true)
		expect(report.issues).toEqual([])
	})

	test("validates non-PR completion invariants without rejecting legacy done work", async () => {
		await write(
			root,
			"agency.json",
			JSON.stringify({
				version: 2,
				repositories: {
					agency: { remote: "https://example.com/agency.git" },
				},
			}),
		)
		await write(
			root,
			"tasks/invalid/TASK.md",
			`---
ticketUrl: null
repo: agency
branch: task/invalid
base: main
pr: https://github.com/example/agency/pull/1
status: working
completion:
  mode: non-pr
  completedAt: 2026-07-23T18:00:00.000Z
  summary: Investigation completed.
---
`,
		)
		await write(
			root,
			"tasks/legacy/TASK.md",
			`---
ticketUrl: null
repo: agency
branch: task/legacy
base: main
pr: null
status: done
---
`,
		)

		const report = await runTestEffect(
			WorkbaseService.pipe(Effect.flatMap((service) => service.validate(root))),
		)
		expect(report.issues).toContainEqual({
			path: "tasks/invalid/TASK.md",
			message: "Non-PR completion requires status 'done'",
		})
		expect(report.issues).toContainEqual({
			path: "tasks/invalid/TASK.md",
			message: "Non-PR completion cannot have a recorded pull request",
		})
		expect(
			report.issues.some((issue) => issue.path === "tasks/legacy/TASK.md"),
		).toBe(false)
	})

	test("registers canonical workbase paths without duplicates", async () => {
		const workbaseRoot = join(root, "workbase")
		const nested = join(workbaseRoot, "nested")
		const configDirectory = join(root, "config")
		await write(workbaseRoot, "agency.json", '{"version":2}\n')
		await mkdir(nested, { recursive: true })

		const first = await runTestEffect(
			WorkbaseService.pipe(
				Effect.flatMap((service) => service.register(nested, configDirectory)),
			),
		)
		await runTestEffect(
			WorkbaseService.pipe(
				Effect.flatMap((service) =>
					service.register(workbaseRoot, configDirectory),
				),
			),
		)
		const registered = await runTestEffect(
			WorkbaseService.pipe(
				Effect.flatMap((service) => service.listRegistered(configDirectory)),
			),
		)

		expect(first.path).toBe(await realpath(workbaseRoot))
		expect(registered).toEqual([first.path])
		expect(
			await Bun.file(join(configDirectory, "agency/workbases.json")).json(),
		).toEqual({ version: 2, workbases: [first] })
	})

	test("resolves names and stable IDs and manages the default", async () => {
		const workbaseRoot = join(root, "workbase")
		const configDirectory = join(root, "config")
		await write(workbaseRoot, "agency.json", '{"version":2}\n')

		const registered = await runTestEffect(
			WorkbaseService.pipe(
				Effect.flatMap((service) =>
					service.register(workbaseRoot, configDirectory, "primary"),
				),
			),
		)
		const result = await runTestEffect(
			WorkbaseService.pipe(
				Effect.flatMap((service) =>
					Effect.gen(function* () {
						yield* service.setDefault("primary", configDirectory)
						return {
							byName: yield* service.resolveRegistered(
								"primary",
								configDirectory,
							),
							byId: yield* service.resolveRegistered(
								registered.id,
								configDirectory,
							),
							defaultWorkbase: yield* service.getDefault(configDirectory),
						}
					}),
				),
			),
		)

		expect(result.byName).toBe(registered.path)
		expect(result.byId).toBe(registered.path)
		expect(result.defaultWorkbase).toEqual(registered)
	})

	test("shows, names, clears names, and defaults by path", async () => {
		const workbaseRoot = join(root, "workbase")
		const configDirectory = join(root, "config")
		await write(workbaseRoot, "agency.json", '{"version":2}\n')
		const registered = await runTestEffect(
			WorkbaseService.pipe(
				Effect.flatMap((service) =>
					service.register(workbaseRoot, configDirectory),
				),
			),
		)

		const result = await runTestEffect(
			WorkbaseService.pipe(
				Effect.flatMap((service) =>
					Effect.gen(function* () {
						const named = yield* service.nameRegistered(
							workbaseRoot,
							"primary",
							configDirectory,
						)
						const shown = yield* service.showRegistered(
							"primary",
							configDirectory,
						)
						const defaultWorkbase = yield* service.setDefault(
							workbaseRoot,
							configDirectory,
						)
						const unnamed = yield* service.nameRegistered(
							registered.id,
							null,
							configDirectory,
						)
						return { named, shown, defaultWorkbase, unnamed }
					}),
				),
			),
		)

		expect(result.named.name).toBe("primary")
		expect(result.shown).toEqual(result.named)
		expect(result.defaultWorkbase?.id).toBe(registered.id)
		expect(result.unnamed).toEqual({ id: registered.id, path: registered.path })
	})

	test("rejects names that collide with stable IDs", async () => {
		const firstRoot = join(root, "first")
		const secondRoot = join(root, "second")
		const configDirectory = join(root, "config")
		await write(firstRoot, "agency.json", '{"version":2}\n')
		await write(secondRoot, "agency.json", '{"version":2}\n')
		const first = await runTestEffect(
			WorkbaseService.pipe(
				Effect.flatMap((service) =>
					service.register(firstRoot, configDirectory),
				),
			),
		)

		await expect(
			runTestEffect(
				WorkbaseService.pipe(
					Effect.flatMap((service) =>
						service.register(secondRoot, configDirectory, first.id),
					),
				),
			),
		).rejects.toThrow("already registered")
	})

	test("rejects invalid workbase names before writing the registry", async () => {
		const workbaseRoot = join(root, "workbase")
		const configDirectory = join(root, "config")
		await write(workbaseRoot, "agency.json", '{"version":2}\n')

		for (const name of ["bad/name", ""]) {
			await expect(
				runTestEffect(
					WorkbaseService.pipe(
						Effect.flatMap((service) =>
							service.register(workbaseRoot, configDirectory, name),
						),
					),
				),
			).rejects.toThrow("Invalid workbase name")
		}
		expect(
			await Bun.file(join(configDirectory, "agency/workbases.json")).exists(),
		).toBe(false)
	})

	test("removes a registration by an equivalent symlink path", async () => {
		const workbaseRoot = join(root, "workbase")
		const linkedRoot = join(root, "linked")
		const configDirectory = join(root, "config")
		await write(workbaseRoot, "agency.json", '{"version":2}\n')
		await symlink(workbaseRoot, linkedRoot)
		await runTestEffect(
			WorkbaseService.pipe(
				Effect.flatMap((service) =>
					service.register(workbaseRoot, configDirectory),
				),
			),
		)

		const removed = await runTestEffect(
			WorkbaseService.pipe(
				Effect.flatMap((service) =>
					service.removeRegistered(linkedRoot, configDirectory),
				),
			),
		)
		expect(removed.path).toBe(await realpath(workbaseRoot))
	})

	test("migrates legacy registrations and prunes stale paths", async () => {
		const workbaseRoot = join(root, "workbase")
		const staleRoot = join(root, "stale")
		const configDirectory = join(root, "config")
		const registryPath = join(configDirectory, "agency/workbases.json")
		await write(workbaseRoot, "agency.json", '{"version":2}\n')
		await write(staleRoot, "agency.json", '{"version":2}\n')
		await write(
			configDirectory,
			"agency/workbases.json",
			JSON.stringify({ version: 1, workbases: [workbaseRoot, staleRoot] }),
		)
		await rm(staleRoot, { recursive: true })

		const result = await runTestEffect(
			WorkbaseService.pipe(
				Effect.flatMap((service) =>
					Effect.gen(function* () {
						const before = yield* service.listRegistrations(configDirectory)
						const removed = yield* service.pruneRegistered(configDirectory)
						return { before, removed }
					}),
				),
			),
		)

		expect(result.before.workbases).toHaveLength(2)
		expect(result.before.workbases[0]?.id).toStartWith("wb-")
		expect(result.removed.map((entry) => entry.path)).toEqual([staleRoot])
		expect(await Bun.file(registryPath).json()).toEqual({
			version: 2,
			workbases: [result.before.workbases[0]],
		})
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

	test("rejects an unknown runner command placeholder", async () => {
		await write(
			root,
			"agency.json",
			JSON.stringify({
				version: 2,
				runners: { custom: { command: ["agent", "{unknown}"] } },
			}),
		)

		await expect(
			runTestEffect(
				WorkbaseService.pipe(
					Effect.flatMap((service) => service.discover(root)),
				),
			),
		).rejects.toThrow("{unknown}")
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
