import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { choose, type ChooserIO } from "./chooser"

const choices = [
	{ key: "first-key", label: "\x1b[32mFirst\x1b[0m", value: 1 },
	{ key: "second key", label: "Second", value: 2 },
]

const createIO = (
	overrides: Partial<ChooserIO> = {},
): ChooserIO & {
	readonly selections: Array<{
		readonly prompt: string
		readonly choices: readonly {
			readonly key: string
			readonly label: string
		}[]
	}>
	readonly inputs: string[]
} => {
	const selections: Array<{
		readonly prompt: string
		readonly choices: readonly {
			readonly key: string
			readonly label: string
		}[]
	}> = []
	const inputs: string[] = []
	return {
		inputIsTTY: true,
		outputIsTTY: true,
		color: false,
		select: async (prompt, choices) => {
			selections.push({ prompt, choices })
			return choices[0]?.key ?? null
		},
		run: async (_command, input) => {
			inputs.push(input)
			return { exitCode: 0, stdout: "first-key\n" }
		},
		...overrides,
		selections,
		inputs,
	}
}

describe("chooser", () => {
	test("offers plain choices to the native interactive renderer", async () => {
		let offered:
			| {
					readonly prompt: string
					readonly choices: readonly {
						readonly key: string
						readonly label: string
					}[]
			  }
			| undefined
		const io = createIO({
			select: async (prompt, offeredChoices) => {
				offered = { prompt, choices: offeredChoices }
				return offeredChoices[1]!.key
			},
		})

		const result = await Effect.runPromise(
			choose("Pick one", choices, undefined, io),
		)

		expect(result).toBe(2)
		expect(offered).toEqual({
			prompt: "Pick one",
			choices: [
				{ key: "first-key", label: "First" },
				{ key: "second key", label: "Second" },
			],
		})
	})

	test("passes hierarchy depth only to the native renderer", async () => {
		let offered: readonly {
			readonly key: string
			readonly label: string
			readonly depth?: number
			readonly segments?: readonly {
				readonly text: string
				readonly color?: string
			}[]
		}[] = []
		const io = createIO({
			select: async (_prompt, choices) => {
				offered = choices
				return choices[0]!.key
			},
		})

		await Effect.runPromise(
			choose(
				"Pick one",
				[
					{
						key: "parent",
						label: "Parent",
						depth: 0,
						segments: [{ text: "P", color: "#c6a0f6" }],
						value: 1,
					},
					{ key: "child", label: "Child", depth: 1, value: 2 },
				],
				undefined,
				io,
			),
		)

		expect(offered).toEqual([
			{
				key: "parent",
				label: "Parent",
				depth: 0,
				segments: [{ text: "P", color: "#c6a0f6" }],
			},
			{ key: "child", label: "Child", depth: 1 },
		])
		expect(io.inputs).toEqual([])
	})

	test("preserves colors for configured external choosers", async () => {
		const io = createIO({ color: true })

		await Effect.runPromise(choose("Pick one", choices, ["chooser"], io))

		expect(io.inputs[0]).toContain("\x1b[32mFirst\x1b[0m")
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
		const native = createIO({ select: async () => null })
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
