import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { spawnProcess } from "./process"

describe("spawnProcess", () => {
	test("captures large stdout and stderr without hanging", async () => {
		const line = "x".repeat(4096)
		const script = [
			`const line = ${JSON.stringify(line)}`,
			"for (let i = 0; i < 2000; i++) {",
			"console.log(`out:${i}:${line}`)",
			"console.error(`err:${i}:${line}`)",
			"}",
		].join("\n")

		const result = await Effect.runPromise(
			spawnProcess([process.execPath, "-e", script]),
		)

		expect(result.exitCode).toBe(0)
		expect(result.stdout).toContain("out:0:")
		expect(result.stdout).toContain("out:1999:")
		expect(result.stderr).toContain("err:0:")
		expect(result.stderr).toContain("err:1999:")
	})
})
