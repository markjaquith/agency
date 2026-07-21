import { Effect } from "effect"

export interface Choice<T> {
	readonly key: string
	readonly label: string
	readonly plainLabel?: string
	readonly depth?: number
	readonly segments?: readonly ChoiceSegment[]
	readonly value: T
}

export interface ChoiceSegment {
	readonly text: string
	readonly color?: string
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
	readonly select: (
		prompt: string,
		choices: readonly {
			readonly key: string
			readonly label: string
			readonly depth?: number
			readonly segments?: readonly ChoiceSegment[]
		}[],
	) => Promise<string | null>
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
	outputIsTTY: Boolean(process.stdout.isTTY),
	color:
		Boolean(process.stdout.isTTY) &&
		process.env.NO_COLOR === undefined &&
		process.env.TERM !== "dumb",
	select: async (prompt, choices) => {
		const { promptSelect } = await (
			await import("./interactive-loader")
		).loadInteractive()
		return promptSelect(prompt, choices)
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
	let key: string | null
	try {
		key = await io.select(
			prompt,
			choices.map((choice) => ({
				key: choice.key,
				label: displayLabel(choice, false),
				...(choice.depth === undefined ? {} : { depth: choice.depth }),
				...(choice.segments === undefined ? {} : { segments: choice.segments }),
			})),
		)
	} catch (cause) {
		throw new ChooserError("input-unavailable", "Failed to read selection", {
			cause,
		})
	}
	return key === null ? null : selectedChoice(key, choices)
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
