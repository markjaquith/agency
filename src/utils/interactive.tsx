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
import { createMemo, createSignal, For, Show } from "solid-js"
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
	readonly fullScreen?: boolean
	readonly onQuit?: () => void
	readonly embedded?: boolean
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
		if (key.propagationStopped) return
		if (isCancel(key)) {
			key.preventDefault()
			key.stopPropagation()
			if (key.ctrl && key.name === "c") props.onQuit?.()
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
			{props.fullScreen && !props.embedded && (
				<>
					<text fg={macchiato.blue}>{"  Agency"}</text>
					<box height={1} flexShrink={0} />
				</>
			)}
			<text fg={macchiato.blue}>
				{props.fullScreen ? `  ${props.prompt}` : props.prompt}
			</text>
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
			<Show when={!props.fullScreen}>
				<text fg={macchiato.overlay1} wrapMode="none">
					enter submit | esc cancel
				</text>
			</Show>
		</box>
	)
}

interface SelectPromptProps extends PromptProps<string> {
	readonly choices: readonly InteractiveChoice[]
	readonly active?: boolean
	readonly reservedRows?: number
	readonly backgroundColor?: string
	readonly emptyLabel?: string
	readonly onTab?: () => void
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
		if (props.active === false || key.propagationStopped) return
		if (key.name === "tab" && props.onTab) {
			key.preventDefault()
			key.stopPropagation()
			props.onTab()
			return
		}
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
			if (key.ctrl && key.name === "c") props.onQuit?.()
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

	const height = () => dimensions().height - (props.reservedRows ?? 0)
	const background = () => props.backgroundColor ?? macchiato.base
	const brandHeight = () => (!props.embedded && height() > 4 ? 1 : 0)
	const gapHeight = () => (height() > (props.embedded ? 3 : 5) ? 1 : 0)
	const visible = () => {
		const visibleCount = Math.max(
			height() - 2 - 2 * brandHeight() - gapHeight(),
			1,
		)
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
			backgroundColor={background()}
		>
			{brandHeight() > 0 && (
				<text fg={macchiato.blue} height={1} flexShrink={0} wrapMode="none">
					{"  Agency"}
				</text>
			)}
			<box height={brandHeight()} flexShrink={0} />
			<text fg={macchiato.blue} height={1} flexShrink={0} wrapMode="none">
				{props.prompt}
			</text>
			<box flexDirection="row" width="100%" height={1} flexShrink={0}>
				<text fg={macchiato.blue}>{"  "}</text>
				<textarea
					focused={props.active !== false}
					flexGrow={1}
					minWidth={8}
					height={1}
					wrapMode="none"
					placeholder="type to filter"
					placeholderColor={macchiato.overlay0}
					backgroundColor={macchiato.mantle}
					focusedBackgroundColor={
						props.embedded ? macchiato.surface1 : macchiato.surface0
					}
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
							if (input && !input.isDestroyed && props.active !== false)
								input.focus()
						})
					}}
				/>
			</box>
			<box height={gapHeight()} flexShrink={0} />
			<box flexDirection="column" flexGrow={1}>
				<For
					each={visible()}
					fallback={
						<text fg={macchiato.overlay1}>
							{query() ? "No matches" : (props.emptyLabel ?? "No matches")}
						</text>
					}
				>
					{({ choice, index, originalIndex }) => (
						<box
							width="100%"
							height={1}
							backgroundColor={
								index === selected() ? macchiato.surface1 : background()
							}
						>
							<text
								fg={index === selected() ? macchiato.text : macchiato.subtext0}
								bg={index === selected() ? macchiato.surface1 : background()}
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
		</box>
	)
}

export interface InteractiveTab {
	readonly id: string
	readonly label: string
	readonly prompt: string
	readonly choices: readonly InteractiveChoice[]
	readonly emptyLabel?: string
}

export const InteractiveTabbedPrompt = (props: {
	readonly tabs: readonly InteractiveTab[]
	readonly onDone: (value: string | null) => void
	readonly onQuit?: () => void
	readonly notice?: string
	readonly initialTab?: number
	readonly onTabChange?: (index: number) => void
	readonly content?: (reservedRows: () => number) => JSX.Element
}) => {
	const dimensions = useTerminalDimensions()
	const [active, setActive] = createSignal(props.initialTab ?? 0)
	const brandHeight = () => (dimensions().height > 5 ? 2 : 0)
	const reservedRows = () => brandHeight() + 1 + (props.notice ? 1 : 0)
	const cycle = () => {
		if (!props.tabs.length) return
		const next = (active() + 1) % props.tabs.length
		setActive(next)
		props.onTabChange?.(next)
	}
	useKeyboard((key) => {
		if (!props.content || key.name !== "tab" || key.propagationStopped) return
		key.preventDefault()
		key.stopPropagation()
		cycle()
	})
	return (
		<box
			flexDirection="column"
			width="100%"
			height="100%"
			backgroundColor={macchiato.surface0}
		>
			<Show when={brandHeight() > 0}>
				<text fg={macchiato.blue} height={1} flexShrink={0}>
					{"  Agency"}
				</text>
				<box height={1} flexShrink={0} />
			</Show>
			<box flexDirection="row" height={1} flexShrink={0}>
				<For each={props.tabs}>
					{(tab, index) => (
						<text
							fg={index() === active() ? macchiato.text : macchiato.overlay1}
							bg={index() === active() ? macchiato.base : macchiato.surface0}
							wrapMode="none"
						>
							<span style={{ fg: macchiato.mauve } as TextNodeOptions}>
								{index() === active() ? "▎" : " "}
							</span>
							{` ${tab.label}  `}
						</text>
					)}
				</For>
			</box>
			<box
				flexDirection="column"
				flexGrow={1}
				minHeight={0}
				backgroundColor={macchiato.base}
			>
				<Show when={props.notice}>
					<text fg={macchiato.text} height={1} flexShrink={0} wrapMode="none">
						{props.notice}
					</text>
				</Show>
				{props.content ? (
					props.content(reservedRows)
				) : (
					<For each={props.tabs}>
						{(tab, index) => (
							<box
								visible={index() === active()}
								width="100%"
								flexGrow={1}
								minHeight={0}
							>
								<InteractiveSelectPrompt
									embedded
									active={index() === active()}
									reservedRows={reservedRows()}
									backgroundColor={macchiato.base}
									prompt={tab.prompt}
									choices={tab.choices}
									emptyLabel={tab.emptyLabel}
									onTab={cycle}
									onDone={props.onDone}
									onQuit={props.onQuit}
								/>
							</box>
						)}
					</For>
				)}
			</box>
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

type SessionView =
	| {
			kind: "tabs"
			tabs: readonly InteractiveTab[]
			finish: (value: string | null) => void
	  }
	| {
			kind: "select"
			prompt: string
			choices: readonly InteractiveChoice[]
			finish: (value: string | null) => void
	  }
	| { kind: "text"; prompt: string; finish: (value: string | null) => void }
	| { kind: "progress"; prompt: string }

/** One terminal owner for a complete guided flow, rather than one per prompt. */
export const createInteractiveSession = async (
	onCancel: () => void = () => {},
	initialTabs: readonly InteractiveTab[] = [],
) => {
	const [view, setView] = createSignal<SessionView>({
		kind: "progress",
		prompt: "Preparing…",
	})
	let pending: ((value: string | null) => void) | undefined
	let closed = false
	let cancelled = false
	let quitRequested = false
	let activeTab = 0
	let frameTabs = initialTabs
	let navigationRequested = false
	const navigate = (index: number) => {
		activeTab = index
		navigationRequested = true
		if (pending) pending(null)
		else {
			cancelled = true
			onCancel()
		}
	}
	const [notice, setNotice] = createSignal("")
	const quit = () => {
		quitRequested = true
		onCancel()
	}
	const Progress = (props: { prompt: string }) => {
		useKeyboard((key) => {
			if (key.propagationStopped) return
			if (!isCancel(key)) return
			key.preventDefault()
			key.stopPropagation()
			cancelled = true
			if (key.ctrl && key.name === "c") quitRequested = true
			onCancel()
		})
		return (
			<box
				flexDirection="column"
				width="100%"
				height="100%"
				backgroundColor={macchiato.base}
			>
				<text fg={macchiato.text}>{props.prompt}</text>
			</box>
		)
	}
	const renderer = await createCliRenderer({
		...interactiveSelectRendererConfig,
		onDestroy: () => {
			closed = true
			pending?.(null)
		},
	})
	try {
		await render(
			() => (
				<Show when={view()} keyed>
					{(current) =>
						current.kind === "tabs" ? (
							<InteractiveTabbedPrompt
								tabs={current.tabs}
								onDone={current.finish}
								onQuit={quit}
								notice={notice()}
								initialTab={activeTab}
								onTabChange={(index) => {
									activeTab = index
								}}
							/>
						) : (
							<InteractiveTabbedPrompt
								tabs={frameTabs}
								initialTab={activeTab}
								notice={notice()}
								onDone={() => {}}
								onTabChange={navigate}
								content={(reservedRows) =>
									current.kind === "select" ? (
										<InteractiveSelectPrompt
											embedded
											reservedRows={reservedRows()}
											prompt={current.prompt}
											choices={current.choices}
											onDone={current.finish}
											onQuit={quit}
										/>
									) : current.kind === "text" ? (
										<InteractiveTextPrompt
											fullScreen
											embedded
											prompt={current.prompt}
											onDone={current.finish}
											onQuit={quit}
										/>
									) : (
										<Progress prompt={current.prompt} />
									)
								}
							/>
						)
					}
				</Show>
			),
			renderer,
		)
	} catch (error) {
		await shutdown(renderer)
		throw error
	}
	const ask = (
		prompt: string,
		choices?: readonly InteractiveChoice[],
		tabs?: readonly InteractiveTab[],
	) => {
		if (closed || cancelled) return Promise.resolve(null)
		return new Promise<string | null>((resolve) => {
			pending = (value) => {
				pending = undefined
				setView({ kind: "progress", prompt: "Preparing next step…" })
				resolve(value)
			}
			setView(
				tabs
					? { kind: "tabs", tabs, finish: pending }
					: choices
						? { kind: "select", prompt, choices, finish: pending }
						: { kind: "text", prompt, finish: pending },
			)
			renderer.requestRender()
		})
	}
	return {
		activateTab: (id: string) => {
			const index = frameTabs.findIndex((tab) => tab.id === id)
			if (index >= 0) activeTab = index
		},
		takeNavigation: () => {
			const requested = navigationRequested
			navigationRequested = false
			return requested
		},
		get quitRequested() {
			return quitRequested
		},
		notice: (message: string) => {
			cancelled = false
			setNotice(message)
		},
		tabs: (tabs: readonly InteractiveTab[]) => {
			frameTabs = tabs
			return ask("", undefined, tabs)
		},
		text: (prompt: string) => ask(prompt),
		select: (prompt: string, choices: readonly InteractiveChoice[]) =>
			ask(prompt, choices),
		show: (prompt: string) => {
			setView({ kind: "progress", prompt })
			renderer.requestRender()
		},
		close: async () => {
			if (closed) return
			closed = true
			pending?.(null)
			await shutdown(renderer)
		},
	}
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
