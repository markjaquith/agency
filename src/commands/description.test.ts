import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { cleanupTempDir, createTempDir, runTestEffect } from "../test-utils"
import { epic } from "./epic"
import { phase } from "./phase"
import { task } from "./task"

describe("create command descriptions", () => {
	let root: string

	beforeEach(async () => {
		root = await createTempDir()
		await Bun.write(join(root, "agency.json"), '{"version":2}\n')
		await mkdir(join(root, "repos/agency"), { recursive: true })
	})

	afterEach(async () => cleanupTempDir(root))

	test("persists and exposes descriptions for every body-of-work shape", async () => {
		await runTestEffect(
			epic({
				subcommand: "create",
				args: ["rollout"],
				ticketUrl: "https://example.com/epic",
				description: "Coordinate the rollout.",
				repos: ["agency:main"],
				cwd: root,
				silent: true,
			}),
		)
		await runTestEffect(
			task({
				subcommand: "create",
				args: ["delivery"],
				ticketUrl: "https://example.com/task",
				description: "Deliver the rollout.",
				multiPhase: true,
				cwd: root,
				silent: true,
			}),
		)
		await runTestEffect(
			phase({
				subcommand: "create",
				args: ["delivery", "contract"],
				description: "Introduce the service contract.",
				repo: "agency",
				branch: "task/contract",
				base: "main",
				cwd: root,
				silent: true,
			}),
		)

		expect(
			await Bun.file(join(root, "epics/rollout/EPIC.md")).text(),
		).toContain("description: Coordinate the rollout.")
		expect(
			await Bun.file(join(root, "tasks/delivery/TASK.md")).text(),
		).toContain("description: Deliver the rollout.")
		expect(
			await Bun.file(
				join(root, "tasks/delivery/phases/contract/PHASE.md"),
			).text(),
		).toContain("description: Introduce the service contract.")

		const output: string[] = []
		const originalLog = console.log
		console.log = (message?: unknown) => output.push(String(message))
		try {
			await runTestEffect(
				epic({ subcommand: "list", args: [], cwd: root, json: true }),
			)
			await runTestEffect(
				task({
					subcommand: "show",
					args: ["delivery"],
					cwd: root,
					json: true,
				}),
			)
			await runTestEffect(
				phase({
					subcommand: "show",
					args: ["delivery", "contract"],
					cwd: root,
					json: true,
				}),
			)
		} finally {
			console.log = originalLog
		}

		expect(JSON.parse(output[0]!)[0].data.description).toBe(
			"Coordinate the rollout.",
		)
		expect(JSON.parse(output[1]!).data.description).toBe("Deliver the rollout.")
		expect(JSON.parse(output[2]!).data.description).toBe(
			"Introduce the service contract.",
		)
	})
})
