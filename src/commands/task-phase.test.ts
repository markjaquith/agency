import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { Effect } from "effect"
import {
	captureLogs,
	cleanupTempDir,
	createTempDir,
	runTestEffect,
} from "../test-utils"
import { phase } from "./phase"
import { task } from "./task"

describe("task and phase command JSON output", () => {
	let root: string

	beforeEach(async () => {
		root = await createTempDir()
		await Bun.write(join(root, "agency.json"), '{"version":2}\n')
		await mkdir(join(root, "repos/agency"), { recursive: true })
		await runTestEffect(
			task({
				subcommand: "create",
				args: ["multi"],
				ticketUrl: "https://example.com/task",
				multiPhase: true,
				cwd: root,
				silent: true,
			}),
		)
		await runTestEffect(
			phase({
				subcommand: "create",
				args: ["multi", "first"],
				repo: "agency",
				branch: "task/first",
				base: "main",
				cwd: root,
				silent: true,
			}),
		)
	})

	afterEach(async () => cleanupTempDir(root))

	test("lists and shows task metadata without Markdown content", async () => {
		const listLogs = await captureLogs(() =>
			runTestEffect(
				task({ subcommand: "list", args: [], cwd: root, json: true }),
			),
		)
		const listed = JSON.parse(listLogs[0]!)
		expect(listed[0].revision).toMatch(/^[a-f0-9]{64}$/)
		expect(listed).toEqual([
			{
				id: "multi",
				path: join(root, "tasks/multi/TASK.md"),
				revision: listed[0].revision,
				data: {
					ticketUrl: "https://example.com/task",
					phases: [{ id: "first" }],
				},
			},
		])

		const showLogs = await captureLogs(() =>
			runTestEffect(
				task({
					subcommand: "show",
					args: ["multi"],
					cwd: root,
					json: true,
				}),
			),
		)
		const shown = JSON.parse(showLogs[0]!)
		expect(shown.revision).toBe(listed[0].revision)
		expect(shown).toEqual({
			id: "multi",
			path: join(root, "tasks/multi/TASK.md"),
			revision: shown.revision,
			data: {
				ticketUrl: "https://example.com/task",
				phases: [{ id: "first" }],
			},
		})
	})

	test("lists and shows phase metadata without Markdown content", async () => {
		const listLogs = await captureLogs(() =>
			runTestEffect(
				phase({ subcommand: "list", args: ["multi"], cwd: root, json: true }),
			),
		)
		const listed = JSON.parse(listLogs[0]!)
		expect(listed[0].revision).toMatch(/^[a-f0-9]{64}$/)
		expect(listed).toEqual([
			{
				taskId: "multi",
				id: "first",
				path: join(root, "tasks/multi/phases/first/PHASE.md"),
				revision: listed[0].revision,
				data: {
					repo: "agency",
					branch: "task/first",
					base: "main",
					pr: null,
					status: "open",
				},
			},
		])

		const showLogs = await captureLogs(() =>
			runTestEffect(
				phase({
					subcommand: "show",
					args: ["multi", "first"],
					cwd: root,
					json: true,
				}),
			),
		)
		const shown = JSON.parse(showLogs[0]!)
		expect(shown.revision).toBe(listed[0].revision)
		expect(shown).toEqual({
			taskId: "multi",
			id: "first",
			path: join(root, "tasks/multi/phases/first/PHASE.md"),
			revision: shown.revision,
			data: {
				repo: "agency",
				branch: "task/first",
				base: "main",
				pr: null,
				status: "open",
			},
		})
	})

	test("renders task and phase operational tables", async () => {
		const taskLogs = await captureLogs(() =>
			runTestEffect(task({ subcommand: "list", args: [], cwd: root })),
		)
		expect(taskLogs[0]).toContain(
			"TASK   PARENT  STATUS  READINESS  REPOSITORIES  BRANCH",
		)
		expect(taskLogs[0]).toContain("multi  -       open    ready")

		const phaseLogs = await captureLogs(() =>
			runTestEffect(phase({ subcommand: "list", args: ["multi"], cwd: root })),
		)
		expect(phaseLogs[0]).toContain(
			"PHASE  PARENT  STATUS  READINESS  REPOSITORIES  BRANCH",
		)
		expect(phaseLogs[0]).toContain(
			"first  multi   open    ready      agency        task/first  absent  absent",
		)
	})

	test("outputs created task and phase records as JSON", async () => {
		const taskLogs = await captureLogs(() =>
			runTestEffect(
				task({
					subcommand: "create",
					args: ["another"],
					ticketUrl: "https://example.com/another",
					multiPhase: true,
					cwd: root,
					json: true,
				}),
			),
		)
		expect(JSON.parse(taskLogs[0]!)).toMatchObject({
			id: "another",
			data: { ticketUrl: "https://example.com/another", phases: [] },
		})

		const phaseLogs = await captureLogs(() =>
			runTestEffect(
				phase({
					subcommand: "create",
					args: ["another", "first"],
					repo: "agency",
					branch: "task/another-first",
					base: "main",
					cwd: root,
					json: true,
				}),
			),
		)
		expect(JSON.parse(phaseLogs[0]!)).toMatchObject({
			taskId: "another",
			id: "first",
			data: {
				repo: "agency",
				branch: "task/another-first",
				base: "main",
				status: "open",
			},
		})
	})

	test("starts work on a newly created phase", async () => {
		const launches: unknown[] = []

		await runTestEffect(
			phase(
				{
					subcommand: "new",
					args: ["multi", "immediate"],
					repo: "agency",
					branch: "task/immediate",
					base: "main",
					work: true,
					auto: true,
					cwd: root,
					silent: true,
				},
				(options) =>
					Effect.sync(() => {
						launches.push(options)
						return undefined
					}),
			),
		)

		expect(launches).toEqual([
			expect.objectContaining({
				taskId: "multi",
				phaseId: "immediate",
				auto: true,
				cwd: root,
			}),
		])
	})

	test("sets task and phase status", async () => {
		const phaseLogs = await captureLogs(() =>
			runTestEffect(
				phase({
					subcommand: "status",
					args: ["multi", "first", "working"],
					cwd: root,
					json: true,
				}),
			),
		)
		expect(JSON.parse(phaseLogs[0]!).data.status).toBe("working")

		await runTestEffect(
			task({
				subcommand: "create",
				args: ["single-status"],
				ticketUrl: "https://example.com/task",
				repo: "agency",
				branch: "task/single-status",
				base: "main",
				cwd: root,
				silent: true,
			}),
		)
		const taskLogs = await captureLogs(() =>
			runTestEffect(
				task({
					subcommand: "status",
					args: ["single-status", "working"],
					cwd: root,
					json: true,
				}),
			),
		)
		expect(JSON.parse(taskLogs[0]!).data.status).toBe("working")
	})

	test("converts a single-phase task with an explicit first phase ID", async () => {
		await runTestEffect(
			task({
				subcommand: "create",
				args: ["single"],
				ticketUrl: "https://example.com/single",
				repo: "agency",
				branch: "task/single",
				base: "main",
				cwd: root,
				silent: true,
			}),
		)

		await runTestEffect(
			phase({
				subcommand: "create",
				args: ["single", "follow-up"],
				firstPhase: "implementation",
				repo: "agency",
				branch: "task/follow-up",
				base: "main",
				dependsOn: ["implementation"],
				cwd: root,
				silent: true,
			}),
		)

		const logs = await captureLogs(() =>
			runTestEffect(
				task({
					subcommand: "show",
					args: ["single"],
					cwd: root,
					json: true,
				}),
			),
		)
		expect(JSON.parse(logs[0]!).data.phases).toEqual([
			{ id: "implementation" },
			{ id: "follow-up", dependsOn: ["implementation"] },
		])
	})
})
