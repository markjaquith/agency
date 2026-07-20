import {
	createCliRenderer,
	type CliRenderer,
	type CliRendererConfig,
	type InputRenderable,
} from "@opentui/core"
import { render, useKeyboard, type JSX } from "@opentui/solid"
import { createSignal, For } from "solid-js"

export interface InteractiveChoice {
	readonly key: string
	readonly label: string
}

export const interactiveRendererConfig = {
	screenMode: "split-footer",
	footerHeight: 4,
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
	let input: InputRenderable | undefined
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
			<input
				focused
				onInput={(next) => {
					value = next
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

export const InteractiveSelectPrompt = (props: SelectPromptProps) => {
	const [selected, setSelected] = createSignal(0)
	useKeyboard((key) => {
		if (isCancel(key) || key.name === "q") {
			key.preventDefault()
			key.stopPropagation()
			props.onDone(null)
			return
		}
		if (key.name === "up" || key.name === "k") {
			key.preventDefault()
			setSelected((current) =>
				current === 0 ? props.choices.length - 1 : current - 1,
			)
			return
		}
		if (key.name === "down" || key.name === "j") {
			key.preventDefault()
			setSelected((current) => (current + 1) % props.choices.length)
			return
		}
		if (key.name !== "return") return
		key.preventDefault()
		key.stopPropagation()
		props.onDone(props.choices[selected()]?.key ?? null)
	})

	const visible = () => {
		const start = Math.min(
			Math.max(selected() - 1, 0),
			Math.max(props.choices.length - 2, 0),
		)
		return props.choices.slice(start, start + 2).map((choice, offset) => ({
			choice,
			index: start + offset,
		}))
	}

	return (
		<box flexDirection="column" width="100%" height="100%">
			<text fg="#7aa2f7">{props.prompt}</text>
			<box flexDirection="column" height={2}>
				<For each={visible()}>
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
			<text fg="#6c7086">up/down navigate | enter select | esc cancel</text>
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
			process.stdout.write("\n")
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
