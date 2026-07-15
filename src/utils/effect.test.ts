import { describe, expect, test } from "bun:test"
import { captureLogs } from "../test-utils"
import { createLoggers } from "./effect"

describe("createLoggers", () => {
	test("keeps JSON output machine-readable when verbose is enabled", async () => {
		const logs = await captureLogs(async () => {
			const { log, verboseLog } = createLoggers({ json: true, verbose: true })
			verboseLog("debug")
			log('{"ok":true}')
		})

		expect(logs).toEqual(['{"ok":true}'])
	})

	test("lets silent suppress JSON output", async () => {
		const logs = await captureLogs(async () => {
			const { log } = createLoggers({ json: true, silent: true })
			log('{"ok":true}')
		})

		expect(logs).toEqual([])
	})
})
