import { describe, expect, spyOn, test } from "bun:test"
import { Effect } from "effect"
import { spawnProcess } from "./process"

describe("spawnProcess", () => {
	test("forwards and captures output in tee mode", async () => {
		const forwardedStdout: Uint8Array[] = []
		const forwardedStderr: Uint8Array[] = []
		const stdout = spyOn(process.stdout, "write").mockImplementation(((
			chunk: Uint8Array,
		) => {
			forwardedStdout.push(chunk)
			return true
		}) as never)
		const stderr = spyOn(process.stderr, "write").mockImplementation(((
			chunk: Uint8Array,
		) => {
			forwardedStderr.push(chunk)
			return true
		}) as never)

		try {
			const result = await Effect.runPromise(
				spawnProcess(
					["sh", "-c", "printf 'standard output'; printf 'standard error' >&2"],
					{ stdout: "tee", stderr: "tee" },
				),
			)

			expect(result).toEqual({
				stdout: "standard output",
				stderr: "standard error",
				exitCode: 0,
			})
			expect(Buffer.concat(forwardedStdout).toString()).toBe("standard output")
			expect(Buffer.concat(forwardedStderr).toString()).toBe("standard error")
		} finally {
			stdout.mockRestore()
			stderr.mockRestore()
		}
	})

	test("captures large stdout and stderr without hanging", async () => {
		const line = "x".repeat(4096)
		const lineCount = 256
		const script = [
			`const line = ${JSON.stringify(line)}`,
			`const indexes = Array.from({ length: ${lineCount} }, (_, i) => i)`,
			"const stdout = indexes.map((i) => `out:${i}:${line}`).join(`\n`)",
			"const stderr = indexes.map((i) => `err:${i}:${line}`).join(`\n`)",
			"const write = (stream, output) => new Promise((resolve, reject) => {",
			"stream.write(output, (error) => error ? reject(error) : resolve())",
			"})",
			"await Promise.all([write(process.stdout, stdout), write(process.stderr, stderr)])",
		].join("\n")

		const result = await Effect.runPromise(
			spawnProcess([process.execPath, "-e", script]),
		)

		expect(result.exitCode).toBe(0)
		expect(result.stdout).toContain("out:0:")
		expect(result.stdout).toContain(`out:${lineCount - 1}:`)
		expect(result.stderr).toContain("err:0:")
		expect(result.stderr).toContain(`err:${lineCount - 1}:`)
	})
})
