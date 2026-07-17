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
					repos: ["agency:main"],
					cwd: root,
					json: true,
				}),
			),
		)

		const created = JSON.parse(logs[0]!)
		expect(created.revision).toMatch(/^[a-f0-9]{64}$/)
		expect(created).toEqual({
			id: "example",
			path: join(root, "epics/example/EPIC.md"),
			revision: created.revision,
			data: {
				ticketUrl: "https://example.com/epic",
				repos: [{ repo: "agency", ref: "main" }],
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
				repos: ["agency:main"],
				cwd: root,
				silent: true,
			}),
		)

		const listLogs = await captureLogs(() =>
			runTestEffect(
				epic({ subcommand: "list", args: [], cwd: root, json: true }),
			),
		)
		const listed = JSON.parse(listLogs[0]!)
		expect(listed[0].revision).toMatch(/^[a-f0-9]{64}$/)
		expect(listed).toEqual([
			{
				id: "example",
				path: join(root, "epics/example/EPIC.md"),
				revision: listed[0].revision,
				data: {
					ticketUrl: "https://example.com/epic",
					repos: [{ repo: "agency", ref: "main" }],
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
		const shown = JSON.parse(showLogs[0]!)
		expect(shown.revision).toBe(listed[0].revision)
		expect(shown).toEqual({
			id: "example",
			path: join(root, "epics/example/EPIC.md"),
			revision: shown.revision,
			data: {
				ticketUrl: "https://example.com/epic",
				repos: [{ repo: "agency", ref: "main" }],
				tasks: [],
			},
		})
	})

	test("renders a readable operational table", async () => {
		await runTestEffect(
			epic({
				subcommand: "create",
				args: ["example"],
				ticketUrl: "https://example.com/epic",
				repos: ["agency:main"],
				cwd: root,
				silent: true,
			}),
		)

		const logs = await captureLogs(() =>
			runTestEffect(epic({ subcommand: "list", args: [], cwd: root })),
		)
		expect(logs[0]).toContain(
			"EPIC     STATUS  READINESS  REPOSITORIES  PR  WORKTREE",
		)
		expect(logs[0]).toContain("example  open    waiting    agency")
		expect(logs[0]).not.toMatch(/[\u{e000}-\u{f8ff}]/u)
	})
})
