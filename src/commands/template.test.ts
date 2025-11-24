import { describe, expect, test } from "bun:test"
import { template } from "./template"
import { runTestEffect } from "../test-utils"

describe("template command", () => {
	test("throws error when no subcommand provided", async () => {
		await expect(
			runTestEffect(
				template({
					args: [],
					silent: true,
				}),
			),
		).rejects.toThrow(
			"Subcommand is required. Available subcommands: use, save, list, view, delete",
		)
	})

	test("throws error for unknown subcommand", async () => {
		await expect(
			runTestEffect(
				template({
					subcommand: "invalid",
					args: [],
					silent: true,
				}),
			),
		).rejects.toThrow(
			"Unknown template subcommand 'invalid'. Available: use, save, list, view, delete",
		)
	})
})
