import { describe, expect, spyOn, test } from "bun:test"
import { captureLogs } from "../test-utils"
import { createLoggers } from "./effect"

describe("createLoggers", () => {
	test("keeps JSON output machine-readable when verbose is enabled", async () => {
		const errors: string[] = []
		const error = spyOn(console, "error").mockImplementation((...args) => {
			errors.push(args.join(" "))
		})
		const logs = await captureLogs(async () => {
			const { log, verboseLog } = createLoggers({ json: true, verbose: true })
			verboseLog("debug")
			log('{"ok":true}')
		})
		error.mockRestore()

		expect(logs).toEqual(['{"ok":true}'])
		expect(errors).toEqual(["debug"])
	})

	test("lets JSON output override silent", async () => {
		const logs = await captureLogs(async () => {
			const { log } = createLoggers({ json: true, silent: true })
			log('{"ok":true}')
		})

		expect(logs).toEqual(['{"ok":true}'])
	})
})
