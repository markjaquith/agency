import { describe, expect, test } from "bun:test"
import { createProgress } from "./progress"

describe("progress", () => {
	test("replaces an active TTY line with its completed state", () => {
		const output: string[] = []
		const progress = createProgress(
			{},
			{ isTTY: true, write: (text) => output.push(text) },
		)

		progress.start("Preparing workspace...")
		progress.succeed("Workspace ready")

		expect(output).toEqual([
			"\r\x1b[2K\x1b[2m○\x1b[0m Preparing workspace...",
			"\r\x1b[2K\x1b[32m✓\x1b[0m Workspace ready\n",
		])
	})

	test("stays quiet for silent or non-TTY output", () => {
		const output: string[] = []
		for (const [silent, isTTY] of [
			[true, true],
			[false, false],
		] as const) {
			const progress = createProgress(
				{ silent },
				{ isTTY, write: (text) => output.push(text) },
			)
			progress.start("Preparing workspace...")
			progress.fail("Workspace preparation failed")
		}

		expect(output).toEqual([])
	})
})
