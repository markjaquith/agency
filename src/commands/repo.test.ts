import { describe, expect, test } from "bun:test"
import { runTestEffect } from "../test-utils"
import { repo } from "./repo"

describe("repo command", () => {
	test("requires a subcommand", async () => {
		await expect(
			runTestEffect(repo({ args: [], silent: true })),
		).rejects.toThrow("Available subcommands: add, link, list")
	})

	test("requires add arguments", async () => {
		await expect(
			runTestEffect(
				repo({ subcommand: "add", args: ["agency"], silent: true }),
			),
		).rejects.toThrow("Usage: agency repo add")
	})
})
