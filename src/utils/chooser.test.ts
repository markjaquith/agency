import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { choose, type ChooserIO } from "./chooser"

const choices = [
	{ key: "first-key", label: "\x1b[32mFirst\x1b[0m", value: 1 },
	{ key: "second key", label: "Second", value: 2 },
]

const createIO = (
	overrides: Partial<ChooserIO> = {},
): ChooserIO & { readonly writes: string[]; readonly inputs: string[] } => {
	const writes: string[] = []
	const inputs: string[] = []
	return {
		inputIsTTY: true,
		outputIsTTY: true,
		color: false,
		write: (message) => writes.push(message),
		question: async () => "1",
		run: async (_command, input) => {
			inputs.push(input)
			return { exitCode: 0, stdout: "first-key\n" }
		},
		...overrides,
		writes,
		inputs,
	}
}

describe("chooser", () => {
	test("offers a plain-text numbered chooser on a TTY", async () => {
		const io = createIO({ question: async () => "2" })

		const result = await Effect.runPromise(
			choose("Pick one", choices, undefined, io),
		)

		expect(result).toBe(2)
		expect(io.writes.join("")).toBe("Pick one\n  1. First\n  2. Second\n")
	})

	test("preserves colors when enabled", async () => {
		const io = createIO({ color: true })

		await Effect.runPromise(choose("Pick one", choices, undefined, io))

		expect(io.writes.join("")).toContain("\x1b[32mFirst\x1b[0m")
	})

	test("passes generic records to an external argv command", async () => {
		const io = createIO()

		const result = await Effect.runPromise(
			choose("Pick one", choices, ["custom-chooser", "--flag"], io),
		)

		expect(result).toBe(1)
		expect(io.inputs).toEqual(["first-key\tFirst\nsecond key\tSecond\n"])
	})

	test("accepts a selected record from fzf or gum", async () => {
		const io = createIO({
			run: async () => ({ exitCode: 0, stdout: "second key\tSecond\n" }),
		})

		expect(
			await Effect.runPromise(choose("Pick", choices, ["gum", "filter"], io)),
		).toBe(2)
	})

	test("treats native and external cancellation as no selection", async () => {
		const native = createIO({ question: async () => "q" })
		const external = createIO({
			run: async () => ({ exitCode: 130, stdout: "" }),
		})

		expect(
			await Effect.runPromise(choose("Pick", choices, undefined, native)),
		).toBeNull()
		expect(
			await Effect.runPromise(choose("Pick", choices, ["chooser"], external)),
		).toBeNull()
	})

	test("uses one typed error for unavailable input and invalid keys", async () => {
		const nonTTY = createIO({ inputIsTTY: false })
		const unknownKey = createIO({
			run: async () => ({ exitCode: 0, stdout: "missing\n" }),
		})

		const unavailable = await Effect.runPromise(
			Effect.flip(choose("Pick", choices, undefined, nonTTY)),
		)
		const invalid = await Effect.runPromise(
			Effect.flip(choose("Pick", choices, ["chooser"], unknownKey)),
		)

		expect(unavailable).toMatchObject({
			name: "ChooserError",
			reason: "input-unavailable",
		})
		expect(invalid).toMatchObject({
			name: "ChooserError",
			reason: "invalid-selection",
		})
	})
})
