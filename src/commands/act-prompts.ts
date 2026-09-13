import { Data, Effect } from "effect"
import { Schema } from "@effect/schema"
import { EntityId } from "../workbase/schemas"
import { choose, type Choice } from "../utils/chooser"

export interface ActInteraction {
	readonly tabs?: <T>(
		tabs: readonly ActTab<T>[],
	) => Effect.Effect<T | null, Error>
	readonly text?: (prompt: string) => Effect.Effect<string | null, Error>
	readonly select: <T>(
		prompt: string,
		choices: readonly Choice<T>[],
		command?: readonly string[],
	) => Effect.Effect<T | null, Error>
}

interface ActTab<T> {
	readonly id: string
	readonly label: string
	readonly prompt: string
	readonly choices: readonly Choice<T>[]
	readonly emptyLabel?: string
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
			select: (prompt, choices, command) =>
				ask(() =>
					interaction.select(
						prompt,
						choices.map((choice) => ({ ...choice, value: choice.key })),
						command,
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
							}).pipe(Effect.zipRight(run()))
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

export const actTabs = [
	{ id: "workstream", label: "  Workstream", prompt: "" },
	{ id: "workbase", label: "  Workbase", prompt: "" },
] as const

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
	select: choose,
	text: readText,
}

export const openActSession = () =>
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
			const session = await (
				await loadInteractive()
			).createInteractiveSession(
				() => cancel(),
				actTabs.map((tab) => ({ ...tab, choices: [] })),
			)
			const attempt = <T>(run: () => Promise<T>) =>
				Effect.tryPromise({
					try: run,
					catch: (cause) => new Error("Interactive session failed", { cause }),
				})
			const interaction: ActInteraction = {
				tabs: (tabs) =>
					attempt(async () => {
						const key = await session.tabs(
							tabs.map((tab) => ({
								...tab,
								choices: tab.choices.map((choice) => ({
									...choice,
									label: choice.plainLabel ?? choice.label,
								})),
							})),
						)
						if (key === null) return null
						const choice = tabs
							.flatMap((tab) => tab.choices)
							.find((choice) => choice.key === key)
						if (!choice) throw new Error("Invalid tab selection")
						return choice.value
					}),
				text: (prompt) => attempt(() => session.text(prompt)),
				select: (prompt, choices) =>
					attempt(async () => {
						const key = await session.select(
							prompt,
							choices.map((choice) => ({
								...choice,
								label: choice.plainLabel ?? choice.label,
							})),
						)
						if (key === null) return null
						const choice = choices.find((choice) => choice.key === key)
						if (!choice) throw new Error("Invalid interactive selection")
						return choice.value
					}),
			}
			return {
				activateTab: session.activateTab,
				takeNavigation: session.takeNavigation,
				get quitRequested() {
					return session.quitRequested
				},
				get navigationRequested() {
					return session.navigationRequested
				},
				resetCancellation,
				notice: session.notice,
				cancelled: Effect.promise(() => cancellation).pipe(
					Effect.flatMap(() => Effect.fail(new ActCancelled())),
				),
				interaction,
				show: session.show,
				close: () => Effect.promise(session.close),
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

export const actionPrompts = (
	interaction: ActInteraction,
	repositories: readonly string[],
	keys: readonly string[],
	chooser?: readonly string[],
) => {
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
		text,
		id: (label: string, suggestion: string, prefix = "") => {
			const base = slug(suggestion)
			let candidate = base
			let suffix = 2
			while (candidate && keys.includes(prefix + candidate))
				candidate = `${base}-${suffix++}`
			return text(label, candidate).pipe(
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
		},
		repository: (preferred?: string) =>
			Effect.gen(function* () {
				if (!repositories.length)
					return yield* Effect.fail(new Error("Add or link a repository first"))
				if (repositories.length === 1) return repositories[0]!
				const ordered = preferred
					? [preferred, ...repositories.filter((repo) => repo !== preferred)]
					: repositories
				const selected = yield* interaction.select(
					"Repository alias",
					ordered.map((value) => ({ key: value, label: value, value })),
					chooser,
				)
				if (selected === null) return yield* Effect.fail(new ActCancelled())
				return selected
			}),
	}
}

export type ActionPrompts = ReturnType<typeof actionPrompts>
