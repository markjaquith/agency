import { describe, expect, test } from "bun:test"
import { template } from "./template"

describe("template command", () => {
	test("throws error when no subcommand provided", async () => {
		await expect(
			template({
				args: [],
				silent: true,
			}),
		).rejects.toThrow(
			"Subcommand is required. Available subcommands: use, save",
		)
	})

	test("throws error for unknown subcommand", async () => {
		await expect(
			template({
				subcommand: "invalid",
				args: [],
				silent: true,
			}),
		).rejects.toThrow(
			"Unknown template subcommand 'invalid'. Available: use, save",
		)
	})
})
