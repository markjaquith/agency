import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { captureLogs } from "../test-utils"
import { PullRequestService } from "../services/PullRequestService"
import { pr } from "./pr"

describe("pr command", () => {
	test("outputs the created pull request URL as JSON", async () => {
		const url = "https://github.com/markjaquith/agency/pull/123"
		let received: unknown[] = []
		const logs = await captureLogs(() =>
			Effect.runPromise(
				pr({
					subcommand: "create",
					taskId: "example",
					phaseId: "implementation",
					draft: true,
					force: true,
					cwd: "/workbase",
					json: true,
				}).pipe(
					Effect.provideService(PullRequestService, {
						create: (...args: unknown[]) => {
							received = args
							return Effect.succeed(url)
						},
					} as never),
				) as Effect.Effect<void, unknown, never>,
			),
		)

		expect(JSON.parse(logs[0]!)).toEqual({ url })
		expect(received).toEqual([
			"example",
			"implementation",
			true,
			"/workbase",
			expect.objectContaining({
				force: true,
				draft: true,
				json: true,
			}),
		])
	})
})
