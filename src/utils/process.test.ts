import { describe, expect, spyOn, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber } from "effect"
import { spawnProcess } from "./process"

const waitFor = async <A>(attempt: () => Promise<A>): Promise<A> => {
	const deadline = Date.now() + 2_000
	while (true) {
		try {
			return await attempt()
		} catch (error) {
			if (Date.now() >= deadline) throw error
			await Bun.sleep(10)
		}
	}
}

const isProcessRunning = (pid: number): boolean => {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === "ESRCH"
		) {
			return false
		}
		throw error
	}
}

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

	test("terminates timed-out process groups", async () => {
		const startedAt = performance.now()
		await expect(
			Effect.runPromise(
				spawnProcess(["sh", "-c", "sleep 30 & wait"], { timeoutMs: 25 }),
			),
		).rejects.toThrow("Process timed out")
		expect(performance.now() - startedAt).toBeLessThan(1_000)
	})

	test("terminates the subprocess when interrupted", async () => {
		const directory = await mkdtemp(join(tmpdir(), "agency-process-"))
		const pidPath = join(directory, "pid")
		const script = [
			`process.on("SIGTERM", () => {})`,
			`await Bun.write(${JSON.stringify(pidPath)}, String(process.pid))`,
			`setInterval(() => process.stdout.write("running\\n"), 10)`,
		].join("\n")
		const fiber = Effect.runFork(spawnProcess([process.execPath, "-e", script]))

		try {
			const pid = Number(await waitFor(() => readFile(pidPath, "utf8")))
			expect(isProcessRunning(pid)).toBe(true)

			await Effect.runPromise(Fiber.interrupt(fiber))

			expect(isProcessRunning(pid)).toBe(false)
		} finally {
			await Effect.runPromise(Fiber.interrupt(fiber))
			await rm(directory, { recursive: true, force: true })
		}
	})
})
