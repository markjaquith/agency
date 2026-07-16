import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { captureLogs } from "../test-utils"
import { PullRequestService } from "../services/PullRequestService"
import { pr } from "./pr"

describe("pr command", () => {
	test("outputs the created pull request URL as JSON", async () => {
		const url = "https://github.com/markjaquith/agency/pull/123"
		const logs = await captureLogs(() =>
			Effect.runPromise(
				pr({
					subcommand: "create",
					taskId: "example",
					json: true,
				}).pipe(
					Effect.provideService(PullRequestService, {
						create: () => Effect.succeed(url),
					} as never),
				) as Effect.Effect<void, unknown, never>,
			),
		)

		expect(JSON.parse(logs[0]!)).toEqual({ url })
	})
})
