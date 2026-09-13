import { Effect } from "effect"
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

export class ActCancelled extends Error {}

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
				return yield* Effect.fail(new Error(`${label} is required`))
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
			return text(label, candidate)
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
