import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { completions } from "./completions"

const captureCompletions = async (shell: string) => {
	const originalLog = console.log
	let output = ""
	console.log = (message: string) => {
		output += message
	}

	try {
		await Effect.runPromise(completions(shell))
	} finally {
		console.log = originalLog
	}

	return output
}

describe("completions command", () => {
	test("generates bash completions", async () => {
		const output = await captureCompletions("bash")

		expect(output).toContain("_agency_completions()")
		expect(output).toContain("complete -F _agency_completions agency")
		expect(output).toContain("completions")
		expect(output).toContain("bash zsh")
	})

	test("generates zsh completions", async () => {
		const output = await captureCompletions("zsh")

		expect(output).toContain("#compdef agency")
		expect(output).toContain("_agency()")
		expect(output).toContain("agency_commands=(")
		expect(output).toContain("bash\\:Generate\\ bash\\ completions")
	})

	test("prints the requested completion script", async () => {
		const output = await captureCompletions("zsh")

		expect(output).toContain("#compdef agency")
	})

	test("rejects unsupported shells", async () => {
		await expect(Effect.runPromise(completions("fish"))).rejects.toThrow(
			"Usage: agency completions <bash|zsh>",
		)
	})
})
