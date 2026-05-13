import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { withSpinner } from "./spinner"

describe("withSpinner", () => {
	test("clears and stops the spinner when an Effect failure has no fail text", async () => {
		const originalNodeEnv = process.env.NODE_ENV
		const originalBunEnv = process.env.BUN_ENV
		delete process.env.NODE_ENV
		delete process.env.BUN_ENV

		const calls: string[] = []
		const error = new Error("boom")

		try {
			await expect(
				Effect.runPromise(
					withSpinner(Effect.fail(error), {
						text: "Working",
						createSpinner: () => ({
							succeed: () => calls.push("succeed"),
							fail: () => calls.push("fail"),
							clear: () => calls.push("clear"),
							stop: () => calls.push("stop"),
						}),
					}),
				),
			).rejects.toThrow("boom")

			expect(calls).toEqual(["clear", "stop"])
		} finally {
			if (originalNodeEnv === undefined) {
				delete process.env.NODE_ENV
			} else {
				process.env.NODE_ENV = originalNodeEnv
			}

			if (originalBunEnv === undefined) {
				delete process.env.BUN_ENV
			} else {
				process.env.BUN_ENV = originalBunEnv
			}
		}
	})
})
