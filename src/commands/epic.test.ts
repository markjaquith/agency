import { describe, expect, test } from "bun:test"
import { runTestEffect } from "../test-utils"
import { epic } from "./epic"

describe("epic command", () => {
	test("requires create arguments", async () => {
		await expect(
			runTestEffect(epic({ subcommand: "create", args: [], silent: true })),
		).rejects.toThrow("Usage: agency epic create")
	})
})
