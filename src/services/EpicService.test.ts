import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { cleanupTempDir, createTempDir, runTestEffect } from "../test-utils"
import { Effect } from "effect"
import { EpicService } from "./EpicService"

describe("EpicService", () => {
	let root: string

	beforeEach(async () => {
		root = await createTempDir()
		await Bun.write(join(root, "agency.json"), '{"version":2}\n')
		await mkdir(join(root, "repos/agency"), { recursive: true })
	})

	afterEach(async () => {
		await cleanupTempDir(root)
	})

	test("creates, lists, and shows epics", async () => {
		const created = await runTestEffect(
			EpicService.pipe(
				Effect.flatMap((service) =>
					service.create(
						"workspace-orchestration",
						"https://example.com/tickets/epic",
						[{ repo: "agency", ref: "main" }],
						root,
					),
				),
			),
		)

		expect(created.content).toContain("ticketUrl:")
		expect(created.content).toContain("tasks: []")
		expect(created.content).toContain(
			"# Workspace Orchestration\n\n## Outcome\n\nDescribe the epic outcome.\n\n## Plan\n\nDescribe the current approach.\n\n## Important Decisions\n\nRecord consequential decisions and their rationale.",
		)

		const records = await runTestEffect(
			EpicService.pipe(Effect.flatMap((service) => service.list(root))),
		)
		expect(records.map((record) => record.id)).toEqual([
			"workspace-orchestration",
		])

		const shown = await runTestEffect(
			EpicService.pipe(
				Effect.flatMap((service) =>
					service.show("workspace-orchestration", root),
				),
			),
		)
		expect(shown.path).toBe(join(root, "epics/workspace-orchestration/EPIC.md"))
	})

	test("rejects unknown repository aliases", async () => {
		await expect(
			runTestEffect(
				EpicService.pipe(
					Effect.flatMap((service) =>
						service.create(
							"example",
							"https://example.com/tickets/epic",
							[{ repo: "missing", ref: "main" }],
							root,
						),
					),
				),
			),
		).rejects.toThrow("Unknown repository alias 'missing'")
	})
})
