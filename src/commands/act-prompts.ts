import { Data, Effect, Schema } from "effect"
import { EntityId } from "../workbase/schemas"
import { choose, type Choice } from "../utils/chooser"
import type {
	createSupervisorSurface,
	SupervisorSurface,
} from "../utils/supervise-tab"

export interface ActInteraction {
	readonly tabs?: <T>(
		tabs: readonly ActTab<T>[],
	) => Effect.Effect<T | null, Error>
	readonly text?: (prompt: string) => Effect.Effect<string | null, Error>
	readonly select: <T>(
		prompt: string,
		choices: readonly Choice<T>[],
		command?: readonly string[],
		/** A confirmation: Enter is ignored briefly after it opens. */
		confirm?: boolean,
	) => Effect.Effect<T | null, Error>
}

interface ActTab<T> {
	readonly id: string
	readonly label: string
	readonly prompt: string
	readonly choices: readonly Choice<T>[]
	readonly emptyLabel?: string
	readonly help?: readonly {
		readonly keys: string
		readonly description: string
	}[]
}

export class ActCancelled extends Data.TaggedError("ActCancelled") {}
class ActInputError extends Data.TaggedError("ActInputError")<{
	readonly message: string
}> {}

/**
 * Collect inputs only: this callback must not execute operations or mutate work.
 * Going back replays its answered prefix, then reopens the preceding prompt.
 * Cache text and stable choice keys, never generic values from a previous run.
 */
export const wizardInputs = <T>(
	interaction: ActInteraction,
	collect: (interaction: ActInteraction) => Effect.Effect<T, Error>,
	canGoBack: () => boolean,
	onInputError: (message?: string) => void = () => {},
): Effect.Effect<T, Error> =>
	Effect.suspend(() => {
		const answers: string[] = []
		let cursor = 0
		const ask = (read: () => Effect.Effect<string | null, Error>) =>
			Effect.suspend(() => {
				const index = cursor++
				if (index < answers.length) return Effect.succeed(answers[index]!)
				return read().pipe(
					Effect.tap((answer) =>
						Effect.sync(() => {
							if (answer !== null) {
								answers.push(answer)
								onInputError()
							}
						}),
					),
				)
			})
		const ui: ActInteraction = {
			...interaction,
			text: (prompt) => ask(() => (interaction.text ?? readText)(prompt)),
			select: (prompt, choices, command, confirm) =>
				ask(() =>
					interaction.select(
						prompt,
						choices.map((choice) => ({ ...choice, value: choice.key })),
						command,
						confirm,
					),
				).pipe(
					Effect.flatMap((key) => {
						if (key === null) return Effect.succeed(null)
						const choice = choices.find((choice) => choice.key === key)
						return choice
							? Effect.succeed(choice.value)
							: Effect.fail(
									new Error(`Wizard choice '${key}' is no longer available`),
								)
					}),
				),
		}
		const run = (): Effect.Effect<T, Error> =>
			Effect.suspend(() => {
				cursor = 0
				return collect(ui).pipe(
					Effect.catchIf(
						(error): error is ActInputError => error instanceof ActInputError,
						(error) => {
							if (!cursor || !canGoBack()) return Effect.fail(error)
							return Effect.sync(() => {
								answers.length = cursor - 1
								onInputError(error.message)
							}).pipe(Effect.andThen(run()))
						},
					),
					Effect.catchIf(
						(error): error is ActCancelled => error instanceof ActCancelled,
						(error) => {
							if (cursor < 2 || !canGoBack()) return Effect.fail(error)
							answers.length = cursor - 2
							onInputError()
							return run()
						},
					),
				)
			})
		return run()
	})

/** Record answered text and stable choice keys so inputs can be replayed later. */
export const recordingInteraction = (
	interaction: ActInteraction,
	answers: string[],
): ActInteraction => ({
	...interaction,
	text: (prompt) =>
		(interaction.text ?? readText)(prompt).pipe(
			Effect.tap((answer) =>
				Effect.sync(() => {
					if (answer !== null) answers.push(answer)
				}),
			),
		),
	select: (prompt, choices, command, confirm) =>
		interaction
			.select(
				prompt,
				choices.map((choice) => ({ ...choice, value: choice.key })),
				command,
				confirm,
			)
			.pipe(
				Effect.map((key) => {
					if (key === null) return null
					answers.push(key)
					return choices.find((choice) => choice.key === key)?.value ?? null
				}),
			),
})

/** Answer prompts from recorded inputs; a missing or stale answer fails. */
export const replayInteraction = (
	answers: readonly string[],
): ActInteraction => {
	let index = 0
	const next = (): Effect.Effect<string, Error> =>
		index < answers.length
			? Effect.succeed(answers[index++]!)
			: Effect.fail(new Error("Recorded action inputs are incomplete"))
	return {
		text: next,
		select: (_prompt, choices) =>
			next().pipe(
				Effect.flatMap((key) => {
					const choice = choices.find((choice) => choice.key === key)
					return choice
						? Effect.succeed(choice.value)
						: Effect.fail(
								new Error(`Recorded choice '${key}' is no longer available`),
							)
				}),
			),
	}
}

const sharedHelp = [
	{ keys: "type", description: "Filter the list" },
	{ keys: "↑/↓ C-p/C-n", description: "Move the selection" },
	{ keys: "Esc", description: "Clear the filter; does nothing when empty" },
	{ keys: "Tab/S-Tab", description: "Switch tabs" },
	{ keys: "?", description: "Show or hide this help (with an empty filter)" },
	{ keys: "C-c", description: "Quit; queued changes finish first" },
]

export const actTabs = [
	{
		id: "workstream",
		label: "  Workstream",
		prompt: "",
		help: [
			{ keys: "Enter", description: "Choose actions for the task or phase" },
			...sharedHelp,
		],
	},
	{
		id: "workbase",
		label: "  Workbase",
		prompt: "",
		help: [
			{ keys: "Enter", description: "Choose a workbase action group" },
			...sharedHelp,
		],
	},
	{ id: "supervise", label: "󰈈  Supervise", prompt: "" },
] as const

export type ActTabId = (typeof actTabs)[number]["id"]

const readText = (prompt: string) =>
	Effect.tryPromise({
		try: async () => {
			const { loadInteractive } = await import("../utils/interactive-loader")
			try {
				return await (await loadInteractive()).promptText(prompt)
			} catch (cause) {
				if (
					cause instanceof Error &&
					cause.message === "Interactive input cancelled"
				)
					return null
				throw cause
			}
		},
		catch: (cause) => new Error("Failed to read action input", { cause }),
	})

export const defaultInteraction: ActInteraction = {
	select: (prompt, choices, command) => choose(prompt, choices, command),
	text: readText,
}

/** Load the Supervise tab; its state outlives each terminal session. */
export const loadSupervisorSurface = (
	options: Parameters<typeof createSupervisorSurface>[0],
) =>
	Effect.tryPromise({
		try: async () => {
			const { loadSupervisorTab } = await import("../utils/interactive-loader")
			return (await loadSupervisorTab()).createSupervisorSurface(options)
		},
		catch: (cause) =>
			new Error(
				`Failed to load the Supervise tab: ${cause instanceof Error ? cause.message : String(cause)}`,
				{ cause },
			),
	})

export const openActSession = (
	options: {
		readonly supervisor?: SupervisorSurface
		readonly onTabChange?: (id: string, previous: string | undefined) => void
	} = {},
) =>
	Effect.tryPromise({
		try: async () => {
			const { loadInteractive } = await import("../utils/interactive-loader")
			let cancel!: () => void
			let cancellation: Promise<void>
			const resetCancellation = () => {
				cancellation = new Promise<void>((resolve) => {
					cancel = resolve
				})
			}
			resetCancellation()
			const { supervisor } = options
			const session = await (
				await loadInteractive()
			).createInteractiveSession(
				() => cancel(),
				actTabs
					.filter((tab) => supervisor || tab.id !== "supervise")
					.map((tab) => ({ ...tab, choices: [] })),
				{
					panels: supervisor ? { supervise: supervisor.panel } : undefined,
					onTabChange: options.onTabChange,
				},
			)
			supervisor?.bind(session)
			const attempt = <T>(run: () => Promise<T>) =>
				Effect.tryPromise({
					try: run,
					catch: (cause) => new Error("Interactive session failed", { cause }),
				})
			const nativeTabs = (tabs: readonly ActTab<unknown>[]) =>
				tabs.map((tab) => ({
					...tab,
					choices: tab.choices.map((choice) => ({
						...choice,
						label: choice.plainLabel ?? choice.label,
					})),
				}))
			let openTabs: readonly ActTab<unknown>[] = []
			const interaction: ActInteraction = {
				tabs: (tabs) =>
					attempt(async () => {
						openTabs = tabs
						const key = await session.tabs(nativeTabs(tabs))
						if (key === null) return null
						const choice = (openTabs as typeof tabs)
							.flatMap((tab) => tab.choices)
							.find((choice) => choice.key === key)
						if (!choice) throw new Error("Invalid tab selection")
						return choice.value
					}),
				text: (prompt) => attempt(() => session.text(prompt)),
				select: (prompt, choices, _command, confirm) =>
					attempt(async () => {
						const key = await session.select(
							prompt,
							choices.map((choice) => ({
								...choice,
								label: choice.plainLabel ?? choice.label,
							})),
							confirm,
						)
						if (key === null) return null
						const choice = choices.find((choice) => choice.key === key)
						if (!choice) throw new Error("Invalid interactive selection")
						return choice.value
					}),
			}
			return {
				activateTab: session.activateTab,
				get activeTabId() {
					return session.activeTabId
				},
				leaveTabs: session.leaveTabs,
				takeNavigation: session.takeNavigation,
				get quitRequested() {
					return session.quitRequested
				},
				get navigationRequested() {
					return session.navigationRequested
				},
				resetCancellation,
				notice: session.notice,
				announce: session.announce,
				queue: session.queue,
				/** Refresh open tabs; choice keys must match the open prompt's. */
				refreshTabs: <T>(tabs: readonly ActTab<T>[]) => {
					openTabs = tabs
					session.refreshTabs(nativeTabs(tabs))
				},
				cancelled: Effect.promise(() => cancellation).pipe(
					Effect.flatMap(() => Effect.fail(new ActCancelled())),
				),
				interaction,
				show: session.show,
				close: () =>
					Effect.promise(() => {
						supervisor?.bind(null)
						return session.close()
					}),
			}
		},
		catch: (cause) =>
			new Error("Failed to open interactive session", { cause }),
	})
const isEntityId = Schema.is(EntityId)
const slug = (text: string) =>
	text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.split("-")
		.slice(0, 5)
		.join("-")
		.slice(0, 60)
		.replace(/-$/, "")

/**
 * Inputs collected by input ID. Each `text`, `id`, or `repository` prompt
 * answers the next declared input, so a wizard can be prefilled from, and
 * report, the same values `agency act --json` templates use.
 */
interface ActionFields {
	readonly inputs: readonly { readonly id: string }[]
	/** Prefilled answers, offered as each prompt's default. */
	readonly defaults: Readonly<Record<string, string>>
	/** Filled with each answered input's final value. */
	readonly values: Record<string, string>
	/** Each prompt's input ID in order; null for a prompt past the inputs. */
	readonly answered: (string | null)[]
}

export const actionPrompts = (
	interaction: ActInteraction,
	repositories: readonly string[],
	keys: readonly string[],
	chooser?: readonly string[],
	fields?: ActionFields,
) => {
	let cursor = 0
	/** Answer the next declared input with a prompt, prefilled from its default. */
	const field = <A extends string>(
		ask: (prefill: string | undefined) => Effect.Effect<A, Error>,
	) =>
		Effect.suspend(() => {
			const input = fields?.inputs[cursor++]
			return ask(input ? fields?.defaults[input.id] : undefined).pipe(
				Effect.tap((value) =>
					Effect.sync(() => {
						if (!fields) return
						fields.answered.push(input?.id ?? null)
						if (input) fields.values[input.id] = value
					}),
				),
			)
		})
	const text = (label: string, fallback = "", required = true) =>
		Effect.gen(function* () {
			const value = yield* (interaction.text ?? readText)(
				`${label}${fallback ? ` [${fallback}]` : ""}: `,
			)
			if (value === null) return yield* Effect.fail(new ActCancelled())
			const answer = value.trim() || fallback
			if (required && !answer)
				return yield* Effect.fail(
					new ActInputError({ message: `${label} is required` }),
				)
			return answer
		})
	return {
		text: (label: string, fallback = "", required = true) =>
			field((prefill) => text(label, prefill ?? fallback, required)),
		confirm: (prompt: string, label = "Confirm") =>
			Effect.gen(function* () {
				const confirmed = yield* interaction.select(
					prompt,
					[
						{ key: "confirm", label, value: true },
						{ key: "cancel", label: "Cancel", value: false },
					],
					chooser,
					true,
				)
				if (!confirmed) return yield* Effect.fail(new ActCancelled())
			}),
		id: (label: string, suggestion: string, prefix = "") =>
			field((prefill) => {
				const base = slug(suggestion)
				let candidate = base
				let suffix = 2
				while (candidate && keys.includes(prefix + candidate))
					candidate = `${base}-${suffix++}`
				return text(label, prefill ?? candidate).pipe(
					Effect.flatMap((value) => {
						if (!isEntityId(value))
							return Effect.fail(
								new ActInputError({
									message: `${label} must start with a letter or number and contain only letters, numbers, dots, underscores, or hyphens`,
								}),
							)
						if (keys.includes(prefix + value))
							return Effect.fail(
								new ActInputError({
									message: `${label} '${value}' is already in use`,
								}),
							)
						return Effect.succeed(value)
					}),
				)
			}),
		repository: (preferred?: string) =>
			field((prefill) =>
				Effect.gen(function* () {
					if (!repositories.length)
						return yield* Effect.fail(
							new Error("Add or link a repository first"),
						)
					if (repositories.length === 1) return repositories[0]!
					const first =
						prefill && repositories.includes(prefill) ? prefill : preferred
					const ordered = first
						? [first, ...repositories.filter((repo) => repo !== first)]
						: repositories
					const selected = yield* interaction.select(
						"Repository alias",
						ordered.map((value) => ({ key: value, label: value, value })),
						chooser,
					)
					if (selected === null) return yield* Effect.fail(new ActCancelled())
					return selected
				}),
			),
	}
}

export type ActionPrompts = ReturnType<typeof actionPrompts>
