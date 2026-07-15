import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { cleanupTempDir, createTempDir, runTestEffect } from "../test-utils"
import { TaskService } from "./TaskService"
import { PullRequestService } from "./PullRequestService"

describe("PullRequestService", () => {
	let root: string

	beforeEach(async () => {
		root = await createTempDir()
		await Bun.write(join(root, "agency.json"), '{"version":2}\n')
		await mkdir(join(root, "repos/agency"), { recursive: true })
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "example",
							ticketUrl: "https://example.com/task",
							repo: "agency",
							branch: "task/example",
							base: "main",
						},
						root,
					),
				),
			),
		)
	})

	afterEach(async () => cleanupTempDir(root))

	test("updates the execution document with a PR URL", async () => {
		const url = "https://github.com/markjaquith/agency/pull/123"
		await runTestEffect(
			PullRequestService.pipe(
				Effect.flatMap((service) =>
					service.setUrl("example", undefined, url, root),
				),
			),
		)
		const task = await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) => service.show("example", root)),
			),
		)
		expect("pr" in task.data && task.data.pr).toBe(url)
	})

	test("rejects non-GitHub PR URLs", async () => {
		await expect(
			runTestEffect(
				PullRequestService.pipe(
					Effect.flatMap((service) =>
						service.setUrl(
							"example",
							undefined,
							"https://example.com/pr/1",
							root,
						),
					),
				),
			),
		).rejects.toThrow("Invalid GitHub pull request URL")
	})
})
