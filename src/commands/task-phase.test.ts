import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
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
		expect(JSON.parse(listLogs[0]!)).toEqual([
			{
				id: "multi",
				path: join(root, "tasks/multi/TASK.md"),
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
		expect(JSON.parse(showLogs[0]!)).toEqual({
			id: "multi",
			path: join(root, "tasks/multi/TASK.md"),
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
		expect(JSON.parse(listLogs[0]!)).toEqual([
			{
				taskId: "multi",
				id: "first",
				path: join(root, "tasks/multi/phases/first/PHASE.md"),
				data: {
					repo: "agency",
					branch: "task/first",
					base: "main",
					pr: null,
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
		expect(JSON.parse(showLogs[0]!)).toEqual({
			taskId: "multi",
			id: "first",
			path: join(root, "tasks/multi/phases/first/PHASE.md"),
			data: {
				repo: "agency",
				branch: "task/first",
				base: "main",
				pr: null,
			},
		})
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
			data: { repo: "agency", branch: "task/another-first", base: "main" },
		})
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
