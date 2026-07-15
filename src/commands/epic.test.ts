import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import {
	captureLogs,
	cleanupTempDir,
	createTempDir,
	runTestEffect,
} from "../test-utils"
import { epic } from "./epic"

describe("epic command", () => {
	let root: string

	beforeEach(async () => {
		root = await createTempDir()
		await Bun.write(join(root, "agency.json"), '{"version":2}\n')
		await mkdir(join(root, "repos/agency"), { recursive: true })
	})

	afterEach(async () => cleanupTempDir(root))

	test("requires create arguments", async () => {
		await expect(
			runTestEffect(epic({ subcommand: "create", args: [], silent: true })),
		).rejects.toThrow("Usage: agency epic create")
	})

	test("outputs the created epic as JSON", async () => {
		const logs = await captureLogs(() =>
			runTestEffect(
				epic({
					subcommand: "create",
					args: ["example"],
					ticketUrl: "https://example.com/epic",
					repos: ["agency"],
					cwd: root,
					json: true,
				}),
			),
		)

		expect(JSON.parse(logs[0]!)).toEqual({
			id: "example",
			path: join(root, "epics/example/EPIC.md"),
			data: {
				ticketUrl: "https://example.com/epic",
				repos: ["agency"],
				tasks: [],
			},
		})
	})

	test("lists and shows stable epic JSON records", async () => {
		await runTestEffect(
			epic({
				subcommand: "create",
				args: ["example"],
				ticketUrl: "https://example.com/epic",
				repos: ["agency"],
				cwd: root,
				silent: true,
			}),
		)

		const listLogs = await captureLogs(() =>
			runTestEffect(
				epic({ subcommand: "list", args: [], cwd: root, json: true }),
			),
		)
		expect(JSON.parse(listLogs[0]!)).toEqual([
			{
				id: "example",
				path: join(root, "epics/example/EPIC.md"),
				data: {
					ticketUrl: "https://example.com/epic",
					repos: ["agency"],
					tasks: [],
				},
			},
		])

		const showLogs = await captureLogs(() =>
			runTestEffect(
				epic({
					subcommand: "show",
					args: ["example"],
					cwd: root,
					json: true,
				}),
			),
		)
		expect(JSON.parse(showLogs[0]!)).toEqual({
			id: "example",
			path: join(root, "epics/example/EPIC.md"),
			data: {
				ticketUrl: "https://example.com/epic",
				repos: ["agency"],
				tasks: [],
			},
		})
	})
})
