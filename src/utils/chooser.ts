import { Effect } from "effect"
import { createInterface } from "node:readline/promises"

export interface Choice<T> {
	readonly key: string
	readonly label: string
	readonly plainLabel?: string
	readonly value: T
}

export type ChooserErrorReason =
	| "invalid-choices"
	| "input-unavailable"
	| "invalid-selection"
	| "command-failed"

export class ChooserError extends Error {
	override readonly name = "ChooserError"

	constructor(
		readonly reason: ChooserErrorReason,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options)
	}
}

interface ExternalResult {
	readonly exitCode: number
	readonly stdout: string
}

export interface ChooserIO {
	readonly inputIsTTY: boolean
	readonly outputIsTTY: boolean
	readonly color: boolean
	readonly write: (message: string) => void
	readonly question: (prompt: string) => Promise<string>
	readonly run: (
		command: readonly string[],
		input: string,
	) => Promise<ExternalResult>
}

const stripAnsi = (value: string) =>
	value.replace(
		/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g,
		"",
	)

const defaultIO = (): ChooserIO => ({
	inputIsTTY: Boolean(process.stdin.isTTY),
	outputIsTTY: Boolean(process.stderr.isTTY),
	color:
		Boolean(process.stderr.isTTY) &&
		process.env.NO_COLOR === undefined &&
		process.env.TERM !== "dumb",
	write: (message) => process.stderr.write(message),
	question: async (prompt) => {
		const input = createInterface({
			input: process.stdin,
			output: process.stderr,
		})
		try {
			return await input.question(prompt)
		} finally {
			input.close()
		}
	},
	run: async (command, input) => {
		const child = Bun.spawn([...command], {
			stdin: new Blob([input]),
			stdout: "pipe",
			stderr: "inherit",
		})
		const [exitCode, stdout] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
		])
		return { exitCode, stdout }
	},
})

const displayLabel = (choice: Choice<unknown>, color: boolean) => {
	const normalized = (
		color ? choice.label : (choice.plainLabel ?? choice.label)
	).replace(/[\r\n]+/g, " ")
	return color ? normalized : stripAnsi(normalized)
}

const validateChoices = <T>(choices: readonly Choice<T>[]) => {
	if (choices.length === 0) {
		throw new ChooserError(
			"invalid-choices",
			"Cannot choose from an empty list",
		)
	}
	const keys = new Set<string>()
	for (const choice of choices) {
		if (!choice.key || /[\t\r\n]/.test(choice.key)) {
			throw new ChooserError(
				"invalid-choices",
				"Chooser keys must be non-empty and cannot contain tabs or newlines",
			)
		}
		if (keys.has(choice.key)) {
			throw new ChooserError(
				"invalid-choices",
				`Duplicate chooser key: ${choice.key}`,
			)
		}
		keys.add(choice.key)
	}
}

const selectedChoice = <T>(key: string, choices: readonly Choice<T>[]) => {
	const selected = choices.find((choice) => choice.key === key)
	if (!selected) {
		throw new ChooserError(
			"invalid-selection",
			`Chooser returned an unknown key: ${key}`,
		)
	}
	return selected.value
}

const externalChoice = async <T>(
	choices: readonly Choice<T>[],
	command: readonly string[],
	io: ChooserIO,
) => {
	let result: ExternalResult
	try {
		const records = `${choices
			.map((choice) => `${choice.key}\t${displayLabel(choice, io.color)}`)
			.join("\n")}\n`
		result = await io.run(command, records)
	} catch (cause) {
		throw new ChooserError(
			"command-failed",
			`Failed to run chooser command: ${command.join(" ")}`,
			{ cause },
		)
	}
	if (result.exitCode === 1 || result.exitCode === 130) return null
	if (result.exitCode !== 0) {
		throw new ChooserError(
			"command-failed",
			`Chooser command exited with code ${result.exitCode}`,
		)
	}
	const output = result.stdout.replace(/\r?\n$/, "")
	if (!output) return null
	if (/[\r\n]/.test(output)) {
		throw new ChooserError(
			"invalid-selection",
			"Chooser command returned more than one key",
		)
	}
	const key = output.split("\t", 1)[0] ?? ""
	return selectedChoice(key, choices)
}

const nativeChoice = async <T>(
	choices: readonly Choice<T>[],
	prompt: string,
	io: ChooserIO,
) => {
	if (!io.inputIsTTY || !io.outputIsTTY) {
		throw new ChooserError(
			"input-unavailable",
			"Interactive selection requires a terminal; provide an explicit value or use --no-input",
		)
	}
	io.write(`${prompt}\n`)
	for (const [index, choice] of choices.entries()) {
		io.write(`  ${index + 1}. ${displayLabel(choice, io.color)}\n`)
	}
	let answer: string
	try {
		answer = (
			await io.question(`Select [1-${choices.length}] (q to cancel): `)
		).trim()
	} catch (cause) {
		if (cause instanceof Error && cause.name === "AbortError") return null
		throw new ChooserError("input-unavailable", "Failed to read selection", {
			cause,
		})
	}
	if (!answer || answer.toLowerCase() === "q") return null
	if (!/^\d+$/.test(answer)) {
		throw new ChooserError("invalid-selection", `Invalid selection: ${answer}`)
	}
	const selected = choices[Number.parseInt(answer, 10) - 1]
	if (!selected) {
		throw new ChooserError(
			"invalid-selection",
			`Selection must be between 1 and ${choices.length}`,
		)
	}
	return selected.value
}

export const choose = <T>(
	prompt: string,
	choices: readonly Choice<T>[],
	command?: readonly string[],
	io: ChooserIO = defaultIO(),
): Effect.Effect<T | null, ChooserError> =>
	Effect.tryPromise({
		try: async () => {
			validateChoices(choices)
			return command
				? await externalChoice(choices, command, io)
				: await nativeChoice(choices, prompt, io)
		},
		catch: (cause) =>
			cause instanceof ChooserError
				? cause
				: new ChooserError("input-unavailable", "Selection failed", { cause }),
	})
