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
		const path = JSON.parse(added[0]!).path

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

		expect(JSON.parse(listed[0]!)).toEqual([path])
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
