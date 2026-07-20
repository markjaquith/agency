/** @jsxImportSource @opentui/solid */

import {
	createCliRenderer,
	type CliRenderer,
	type CliRendererConfig,
	type TextareaRenderable,
} from "@opentui/core"
import { render, useKeyboard, type JSX } from "@opentui/solid"
import { createMemo, createSignal, For } from "solid-js"

export interface InteractiveChoice {
	readonly key: string
	readonly label: string
}

export const interactiveRendererConfig = {
	screenMode: "split-footer",
	footerHeight: 5,
	externalOutputMode: "capture-stdout",
	consoleMode: "disabled",
	clearOnShutdown: false,
	exitOnCtrlC: false,
	useMouse: false,
	autoFocus: false,
	openConsoleOnError: false,
} satisfies CliRendererConfig

interface PromptProps<T> {
	readonly prompt: string
	readonly onDone: (value: T | null) => void
}

const isCancel = (key: { name: string; ctrl: boolean }) =>
	key.name === "escape" || (key.ctrl && key.name === "c")

export const InteractiveTextPrompt = (props: PromptProps<string>) => {
	let input: TextareaRenderable | undefined
	let value = ""
	useKeyboard((key) => {
		if (isCancel(key)) {
			key.preventDefault()
			key.stopPropagation()
			props.onDone(null)
			return
		}
		if (key.name !== "return") return
		key.preventDefault()
		key.stopPropagation()
		props.onDone(value)
	})

	return (
		<box flexDirection="column" width="100%" height="100%">
			<text fg="#7aa2f7">{props.prompt}</text>
			<textarea
				focused
				height={2}
				wrapMode="word"
				keyBindings={[{ name: "return", action: "submit" }]}
				onContentChange={() => {
					value = input?.plainText ?? ""
				}}
				ref={(next) => {
					input = next
					queueMicrotask(() => {
						if (input && !input.isDestroyed) input.focus()
					})
				}}
			/>
			<text fg="#6c7086">enter submit | esc cancel</text>
		</box>
	)
}

interface SelectPromptProps extends PromptProps<string> {
	readonly choices: readonly InteractiveChoice[]
}

const isWordBoundary = (value: string, index: number) =>
	index === 0 || /[\s/_.:-]/.test(value[index - 1]!)

const fuzzyScore = (value: string, query: string) => {
	const candidate = value.toLowerCase()
	const needle = query.toLowerCase()
	let previous = new Float64Array(candidate.length)
	let current = new Float64Array(candidate.length)
	previous.fill(Number.NEGATIVE_INFINITY)
	let bestScore = Number.NEGATIVE_INFINITY

	for (let queryIndex = 0; queryIndex < needle.length; queryIndex++) {
		current.fill(Number.NEGATIVE_INFINITY)
		let bestEarlier = Number.NEGATIVE_INFINITY
		bestScore = Number.NEGATIVE_INFINITY
		for (let index = 0; index < candidate.length; index++) {
			if (queryIndex > 0 && index > 0) {
				bestEarlier = Math.max(bestEarlier, previous[index - 1]! + index - 1)
			}
			if (candidate[index] !== needle[queryIndex]) continue

			const boundaryBonus = isWordBoundary(candidate, index) ? 8 : 0
			if (queryIndex === 0) {
				current[index] = 10 + boundaryBonus - index
				bestScore = Math.max(bestScore, current[index]!)
				continue
			}

			const contiguous =
				index > 0 ? previous[index - 1]! + 12 : Number.NEGATIVE_INFINITY
			const gapped = bestEarlier - index + 1
			current[index] = Math.max(contiguous, gapped) + 10 + boundaryBonus
			bestScore = Math.max(bestScore, current[index]!)
		}
		if (!Number.isFinite(bestScore)) return null
		const swap = previous
		previous = current
		current = swap
	}

	return bestScore - candidate.length / 1000
}

export const fuzzyChoices = (
	choices: readonly InteractiveChoice[],
	query: string,
) => {
	if (!query) return choices
	return choices
		.map((choice, index) => ({
			choice,
			index,
			score: fuzzyScore(choice.label, query),
		}))
		.filter(
			(
				match,
			): match is typeof match & {
				score: number
			} => match.score !== null,
		)
		.sort((left, right) => right.score - left.score || left.index - right.index)
		.map((match) => match.choice)
}

export const InteractiveSelectPrompt = (props: SelectPromptProps) => {
	let input: TextareaRenderable | undefined
	const [query, setQuery] = createSignal("")
	const [selected, setSelected] = createSignal(0)
	const choices = createMemo(() => fuzzyChoices(props.choices, query()))
	const move = (offset: -1 | 1) => {
		const count = choices().length
		if (count === 0) return
		setSelected((current) => (current + offset + count) % count)
	}
	useKeyboard((key) => {
		if (isCancel(key)) {
			key.preventDefault()
			key.stopPropagation()
			props.onDone(null)
			return
		}
		if (key.name === "up" || (key.ctrl && key.name === "p")) {
			key.preventDefault()
			key.stopPropagation()
			move(-1)
			return
		}
		if (key.name === "down" || (key.ctrl && key.name === "n")) {
			key.preventDefault()
			key.stopPropagation()
			move(1)
			return
		}
		if (key.name !== "return") return
		key.preventDefault()
		key.stopPropagation()
		const choice = choices()[selected()]
		if (choice) props.onDone(choice.key)
	})

	const visible = () => {
		const start = Math.min(
			Math.max(selected() - 1, 0),
			Math.max(choices().length - 2, 0),
		)
		return choices()
			.slice(start, start + 2)
			.map((choice, offset) => ({
				choice,
				index: start + offset,
			}))
	}

	return (
		<box flexDirection="column" width="100%" height="100%">
			<box flexDirection="row" width="100%">
				<text fg="#7aa2f7" flexShrink={1} wrapMode="none">
					{props.prompt}
				</text>
				<text fg="#7aa2f7">{" > "}</text>
				<textarea
					focused
					flexGrow={1}
					minWidth={8}
					height={2}
					wrapMode="word"
					placeholder="filter"
					keyBindings={[{ name: "return", action: "submit" }]}
					onContentChange={() => {
						setQuery(input?.plainText ?? "")
						setSelected(0)
					}}
					ref={(next) => {
						input = next
						queueMicrotask(() => {
							if (input && !input.isDestroyed) input.focus()
						})
					}}
				/>
			</box>
			<box flexDirection="column" height={2}>
				<For each={visible()} fallback={<text fg="#6c7086">No matches</text>}>
					{({ choice, index }) => (
						<text
							fg={index === selected() ? "#c0caf5" : "#6c7086"}
							wrapMode="none"
						>
							{index === selected() ? "> " : "  "}
							{choice.label}
						</text>
					)}
				</For>
			</box>
			<text fg="#6c7086" wrapMode="none">
				enter select | esc cancel | ctrl-n/p or arrows
			</text>
		</box>
	)
}

const shutdown = async (renderer: CliRenderer) => {
	await renderer.idle().catch(() => undefined)
	if (renderer.externalOutputMode === "capture-stdout") {
		renderer.externalOutputMode = "passthrough"
	}
	if (renderer.screenMode === "split-footer")
		renderer.screenMode = "main-screen"
	if (!renderer.isDestroyed) renderer.destroy()
}

async function runInteractive<T>(
	view: (finish: (value: T | null) => void) => JSX.Element,
) {
	let finish!: (value: T | null) => void
	let settled = false
	const result = new Promise<T | null>((resolve) => {
		finish = (value) => {
			if (settled) return
			settled = true
			resolve(value)
		}
	})
	let renderer: CliRenderer | undefined
	try {
		renderer = await createCliRenderer({
			...interactiveRendererConfig,
			onDestroy: () => finish(null),
		})
		await render(() => view(finish), renderer)
		renderer.requestRender()
		return await result
	} finally {
		if (renderer) {
			await shutdown(renderer)
		}
	}
}

export const promptText = async (prompt: string) => {
	const result = await runInteractive<string>((finish) => (
		<InteractiveTextPrompt prompt={prompt} onDone={finish} />
	))
	if (result === null) throw new Error("Interactive input cancelled")
	return result
}

export const promptSelect = (
	prompt: string,
	choices: readonly InteractiveChoice[],
) =>
	runInteractive<string>((finish) => (
		<InteractiveSelectPrompt
			prompt={prompt}
			choices={choices}
			onDone={finish}
		/>
	))
