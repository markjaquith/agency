/** @jsxImportSource @opentui/solid */

import {
	createCliRenderer,
	type CliRenderer,
	type CliRendererConfig,
	type TextareaRenderable,
	type TextNodeOptions,
} from "@opentui/core"
import {
	render,
	useKeyboard,
	useTerminalDimensions,
	type JSX,
} from "@opentui/solid"
import { createMemo, createSignal, For } from "solid-js"
import type { ChoiceSegment } from "./chooser"
import { macchiato } from "./theme"

export interface InteractiveChoice {
	readonly key: string
	readonly label: string
	readonly depth?: number
	readonly segments?: readonly ChoiceSegment[]
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

export const interactiveSelectRendererConfig = {
	...interactiveRendererConfig,
	screenMode: "alternate-screen",
	externalOutputMode: "passthrough",
} satisfies CliRendererConfig

interface PromptProps<T> {
	readonly prompt: string
	readonly onDone: (value: T | null) => void
}

const isCancel = (key: { name: string; ctrl: boolean }) =>
	key.name === "escape" || (key.ctrl && key.name === "c")

interface PromptKey {
	readonly name: string
	readonly ctrl: boolean
	preventDefault(): void
	stopPropagation(): void
}

const removedText = (before: string, after: string) => {
	let start = 0
	while (
		start < before.length &&
		start < after.length &&
		before[start] === after[start]
	) {
		start++
	}

	let end = 0
	while (
		before[before.length - end - 1] === after[after.length - end - 1] &&
		end < before.length - start &&
		end < after.length - start
	) {
		end++
	}

	return before.slice(start, before.length - end)
}

const createReadlineEditing = (
	getInput: () => TextareaRenderable | undefined,
	onInput?: (value: string) => void,
) => {
	let value = ""
	let killBuffer = ""
	let beforeKill: string | undefined

	return {
		get value() {
			return value
		},
		handleInput(next: string) {
			if (beforeKill !== undefined) {
				const killed = removedText(beforeKill, next)
				if (killed) killBuffer = killed
				beforeKill = undefined
			}
			value = next
			onInput?.(next)
		},
		handleKey(key: PromptKey) {
			const current = getInput()?.plainText
			if (current !== undefined && current !== value) this.handleInput(current)
			if (!key.ctrl) return false
			if (key.name === "y") {
				key.preventDefault()
				key.stopPropagation()
				if (killBuffer) getInput()?.insertText(killBuffer)
				return true
			}
			if (key.name === "u" || key.name === "k" || key.name === "w") {
				beforeKill = value
			}
			return false
		},
	}
}

export const InteractiveTextPrompt = (props: PromptProps<string>) => {
	let input: TextareaRenderable | undefined
	const editing = createReadlineEditing(() => input)
	useKeyboard((key) => {
		if (isCancel(key)) {
			key.preventDefault()
			key.stopPropagation()
			props.onDone(null)
			return
		}
		if (editing.handleKey(key)) return
		if (key.name !== "return") return
		key.preventDefault()
		key.stopPropagation()
		props.onDone(editing.value)
	})

	return (
		<box
			flexDirection="column"
			width="100%"
			height="100%"
			backgroundColor={macchiato.base}
		>
			<text fg={macchiato.blue}>{props.prompt}</text>
			<textarea
				focused
				height={2}
				wrapMode="word"
				backgroundColor={macchiato.mantle}
				focusedBackgroundColor={macchiato.surface0}
				textColor={macchiato.text}
				focusedTextColor={macchiato.text}
				cursorColor={macchiato.rosewater}
				keyBindings={[{ name: "return", action: "submit" }]}
				onContentChange={() => {
					editing.handleInput(input?.plainText ?? "")
				}}
				ref={(next) => {
					input = next
					queueMicrotask(() => {
						if (input && !input.isDestroyed) input.focus()
					})
				}}
			/>
			<text fg={macchiato.overlay1} wrapMode="none">
				enter submit | esc cancel | ctrl-y yank
			</text>
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

const choiceDepth = (choice: InteractiveChoice) => choice.depth ?? 0

const hasSibling = (
	choices: readonly InteractiveChoice[],
	index: number,
	direction: -1 | 1,
) => {
	const depth = choiceDepth(choices[index]!)
	for (
		let siblingIndex = index + direction;
		siblingIndex >= 0 && siblingIndex < choices.length;
		siblingIndex += direction
	) {
		const siblingDepth = choiceDepth(choices[siblingIndex]!)
		if (siblingDepth < depth) return false
		if (siblingDepth === depth) return true
	}
	return false
}

export const hierarchyPrefix = (
	choices: readonly InteractiveChoice[],
	index: number,
) => {
	const choice = choices[index]
	if (!choice || choice.depth === undefined) return ""
	const depth = choiceDepth(choice)
	let prefix = ""
	let ancestorIndex = index

	for (let ancestorDepth = depth - 1; ancestorDepth >= 0; ancestorDepth--) {
		for (ancestorIndex--; ancestorIndex >= 0; ancestorIndex--) {
			if (choiceDepth(choices[ancestorIndex]!) === ancestorDepth) break
		}
		prefix = `${ancestorIndex >= 0 && hasSibling(choices, ancestorIndex, 1) ? "│  " : "   "}${prefix}`
	}

	const hasPrevious = hasSibling(choices, index, -1)
	const hasNext = hasSibling(choices, index, 1)
	return `${prefix}${!hasPrevious && hasNext ? "╭" : hasNext ? "├" : "╰"}─ `
}

export const InteractiveSelectPrompt = (props: SelectPromptProps) => {
	let input: TextareaRenderable | undefined
	const dimensions = useTerminalDimensions()
	const [query, setQuery] = createSignal("")
	const editing = createReadlineEditing(() => input, setQuery)
	const [selected, setSelected] = createSignal(0)
	const choices = createMemo(() => fuzzyChoices(props.choices, query()))
	const displaySegments = (choice: InteractiveChoice) =>
		choice.segments ?? [{ text: choice.label }]
	const move = (offset: -1 | 1) => {
		const count = choices().length
		if (count === 0) return
		setSelected((current) => (current + offset + count) % count)
	}
	useKeyboard((key) => {
		if (key.name === "escape" && query()) {
			key.preventDefault()
			key.stopPropagation()
			input?.clear()
			editing.handleInput("")
			setQuery("")
			setSelected(0)
			return
		}
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
		if (editing.handleKey(key)) return
		if (key.name !== "return") return
		key.preventDefault()
		key.stopPropagation()
		const choice = choices()[selected()]
		if (choice) props.onDone(choice.key)
	})

	const visible = () => {
		const visibleCount = Math.max(dimensions().height - 3, 1)
		const start = Math.min(
			Math.max(selected() - Math.floor(visibleCount / 2), 0),
			Math.max(choices().length - visibleCount, 0),
		)
		return choices()
			.slice(start, start + visibleCount)
			.map((choice, offset) => ({
				choice,
				index: start + offset,
				originalIndex: props.choices.indexOf(choice),
			}))
	}

	return (
		<box
			flexDirection="column"
			width="100%"
			height="100%"
			backgroundColor={macchiato.base}
		>
			<box flexDirection="row" width="100%">
				<text fg={macchiato.blue} flexShrink={1} wrapMode="none">
					{props.prompt}
				</text>
				<text fg={macchiato.blue}>{" > "}</text>
				<textarea
					focused
					flexGrow={1}
					minWidth={8}
					height={2}
					wrapMode="word"
					placeholder="filter"
					placeholderColor={macchiato.overlay0}
					backgroundColor={macchiato.mantle}
					focusedBackgroundColor={macchiato.surface0}
					textColor={macchiato.text}
					focusedTextColor={macchiato.text}
					cursorColor={macchiato.rosewater}
					keyBindings={[{ name: "return", action: "submit" }]}
					onContentChange={() => {
						editing.handleInput(input?.plainText ?? "")
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
			<box flexDirection="column" flexGrow={1}>
				<For
					each={visible()}
					fallback={<text fg={macchiato.overlay1}>No matches</text>}
				>
					{({ choice, index, originalIndex }) => (
						<box
							width="100%"
							height={1}
							backgroundColor={
								index === selected() ? macchiato.surface1 : macchiato.base
							}
						>
							<text
								fg={index === selected() ? macchiato.text : macchiato.subtext0}
								bg={index === selected() ? macchiato.surface1 : macchiato.base}
								wrapMode="none"
							>
								<span
									style={
										{
											fg: index === selected() ? macchiato.mauve : undefined,
										} as TextNodeOptions
									}
								>
									{index === selected() ? "▌ " : "  "}
								</span>
								<span style={{ fg: macchiato.overlay1 } as TextNodeOptions}>
									{query() ? "" : hierarchyPrefix(props.choices, originalIndex)}
								</span>
								<For each={displaySegments(choice)}>
									{(segment) => (
										<span style={{ fg: segment.color } as TextNodeOptions}>
											{segment.text}
										</span>
									)}
								</For>
							</text>
						</box>
					)}
				</For>
			</box>
			<text fg={macchiato.overlay1} wrapMode="none">
				enter select | esc clear/cancel | arrows/ctrl-n/p | ctrl-y yank
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
	config: CliRendererConfig = interactiveRendererConfig,
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
			...config,
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
	runInteractive<string>(
		(finish) => (
			<InteractiveSelectPrompt
				prompt={prompt}
				choices={choices}
				onDone={finish}
			/>
		),
		interactiveSelectRendererConfig,
	)
