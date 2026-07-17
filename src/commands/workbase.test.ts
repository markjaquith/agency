import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import {
	captureLogs,
	cleanupTempDir,
	createTempDir,
	runTestEffect,
} from "../test-utils"
import { workbase } from "./workbase"

describe("workbase command", () => {
	let root: string
	let configDirectory: string

	beforeEach(async () => {
		root = await createTempDir()
		configDirectory = join(root, "config")
		await Bun.write(join(root, "agency.json"), '{"version":2}\n')
	})

	afterEach(async () => cleanupTempDir(root))

	test("adds and lists workbases as JSON", async () => {
		const added = await captureLogs(() =>
			runTestEffect(
				workbase({
					subcommand: "add",
					args: [root],
					configDirectory,
					json: true,
				}),
			),
		)
		const registration = JSON.parse(added[0]!)

		const listed = await captureLogs(() =>
			runTestEffect(
				workbase({
					subcommand: "list",
					args: [],
					configDirectory,
					json: true,
				}),
			),
		)

		expect(JSON.parse(listed[0]!)).toEqual({
			workbases: [registration],
		})
	})

	test("sets, clears, and removes the default workbase", async () => {
		const added = await captureLogs(() =>
			runTestEffect(
				workbase({
					subcommand: "add",
					args: [root],
					name: "primary",
					configDirectory,
					json: true,
				}),
			),
		)
		const registration = JSON.parse(added[0]!)

		await runTestEffect(
			workbase({
				subcommand: "default",
				args: ["primary"],
				configDirectory,
				silent: true,
			}),
		)
		const listed = await captureLogs(() =>
			runTestEffect(
				workbase({
					subcommand: "list",
					args: [],
					configDirectory,
					json: true,
				}),
			),
		)
		expect(JSON.parse(listed[0]!).defaultId).toBe(registration.id)
		await runTestEffect(
			workbase({
				subcommand: "default",
				args: [],
				clear: true,
				configDirectory,
				silent: true,
			}),
		)
		expect(
			await Bun.file(join(configDirectory, "agency/workbases.json")).json(),
		).toEqual({ version: 2, workbases: [registration] })

		await runTestEffect(
			workbase({
				subcommand: "remove",
				args: [registration.id],
				configDirectory,
				silent: true,
			}),
		)
		expect(
			await Bun.file(join(configDirectory, "agency/workbases.json")).json(),
		).toEqual({ version: 2, workbases: [] })
	})

	test("names, shows, and clears a workbase name", async () => {
		const added = await captureLogs(() =>
			runTestEffect(
				workbase({
					subcommand: "add",
					args: [root],
					configDirectory,
					json: true,
				}),
			),
		)
		const registration = JSON.parse(added[0]!)
		await runTestEffect(
			workbase({
				subcommand: "name",
				args: [registration.id, "primary"],
				configDirectory,
				silent: true,
			}),
		)

		const shown = await captureLogs(() =>
			runTestEffect(
				workbase({
					subcommand: "show",
					args: ["primary"],
					configDirectory,
					json: true,
				}),
			),
		)
		expect(JSON.parse(shown[0]!).name).toBe("primary")

		await runTestEffect(
			workbase({
				subcommand: "name",
				args: [registration.id],
				clear: true,
				configDirectory,
				silent: true,
			}),
		)
		expect(
			await Bun.file(join(configDirectory, "agency/workbases.json")).json(),
		).toEqual({ version: 2, workbases: [registration] })
	})

	test("requires an add path", async () => {
		await expect(
			runTestEffect(
				workbase({
					subcommand: "add",
					args: [],
					configDirectory,
					silent: true,
				}),
			),
		).rejects.toThrow("Usage: agency workbase add <path>")
	})
})
