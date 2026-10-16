/** @jsxImportSource @opentui/solid */

import {
	createCliRenderer,
	type CliRenderer,
	type TextNodeOptions,
} from "@opentui/core"
import { render, useKeyboard, useTerminalDimensions } from "@opentui/solid"
import {
	createEffect,
	createMemo,
	createSignal,
	For,
	Show,
	untrack,
} from "solid-js"
import type { SupervisorAction } from "../attention-schema"
import type {
	BadgeTone,
	SuperviseItem,
	SuperviseModel,
} from "../workbase/supervise-view"
import {
	InteractiveSelectPrompt,
	InteractiveTextPrompt,
	interactiveSelectRendererConfig,
	type InteractiveChoice,
} from "./interactive"
import { macchiato } from "./theme"

export type NoticeTone = "info" | "success" | "warning" | "error"

export interface SupervisorNotice {
	readonly text: string
	readonly tone: NoticeTone
}

export interface SupervisorStatus {
	/** Runtime events are streaming. */
	readonly live: boolean
	readonly refreshing: boolean
	/** An action is being prepared or run. */
	readonly busy: boolean
	readonly updatedAt: Date | null
}

export interface SupervisorHandlers {
	readonly onExecute: (item: SuperviseItem, action: SupervisorAction) => void
	readonly onFocus: (item: SuperviseItem) => void
	readonly onRefresh: () => void
	readonly onEditPrompt: (item: SuperviseItem | null) => void
	readonly onSnooze: (item: SuperviseItem) => void
	readonly onDismiss: (item: SuperviseItem) => void
	readonly onQuit: () => void
}

export interface ConfirmRequest {
	readonly title: string
	readonly rationale: string
	readonly risk: SupervisorAction["risk"]
	/** Exactly what will run. */
	readonly preview: readonly string[]
	/** Require a second, explicit confirmation. */
	readonly destructive: boolean
}

/** What the user confirmed: once, and for destructive actions, twice. */
export interface SupervisorConfirmation {
	readonly confirmed: boolean
	readonly destructiveConfirmed: boolean
}

const DECLINED: SupervisorConfirmation = {
	confirmed: false,
	destructiveConfirmed: false,
}

/** Enter is ignored this long after a dialog opens, so a double press can't confirm. */
const CONFIRM_DELAY_MS = 250

type Modal =
	| { readonly kind: "help" }
	| {
			readonly kind: "confirm"
			readonly request: ConfirmRequest
			readonly stage: 1 | 2
			readonly openedAt: number
			readonly resolve: (value: SupervisorConfirmation) => void
	  }
	| {
			readonly kind: "text"
			readonly prompt: string
			readonly resolve: (value: string | null) => void
	  }
	| {
			readonly kind: "choose"
			readonly prompt: string
			readonly choices: readonly InteractiveChoice[]
			readonly resolve: (value: string | null) => void
	  }

interface Binding {
	readonly keys: string
	readonly description: string
	/** Shown in the footer as well as in help. */
	readonly footer?: string
}

/** The single source for help and the footer. */
export const SUPERVISOR_BINDINGS: readonly Binding[] = [
	{ keys: "↑/↓ j/k C-p/C-n", description: "Move between items" },
	{ keys: "Home/End", description: "First or last item" },
	{
		keys: "←/→ Tab/S-Tab",
		description: "Choose an action",
		footer: "←/→ action",
	},
	{ keys: "1–9", description: "Choose an action by number" },
	{
		keys: "Enter",
		description: "Preview, confirm, and run the action",
		footer: "enter run",
	},
	{ keys: "f", description: "Focus the item's pane", footer: "f focus" },
	{ keys: "r", description: "Refresh now", footer: "r refresh" },
	{
		keys: "e",
		description: "Edit the workbase supervision prompt in $EDITOR",
		footer: "e prompt",
	},
	{ keys: "s", description: "Snooze the item", footer: "s snooze" },
	{
		keys: "d",
		description: "Dismiss the item until it changes",
		footer: "d dismiss",
	},
	{ keys: "?", description: "Show or hide this help", footer: "? help" },
	{
		keys: "Esc",
		description:
			"Cancel a dialog (in text input, clear it first) or close this help; does nothing in the list",
	},
	{
		keys: "C-c",
		description: "Quit (cancels any open dialog first)",
		footer: "C-c quit",
	},
]

const toneColor: Record<BadgeTone, string> = {
	red: macchiato.red,
	yellow: macchiato.yellow,
	green: macchiato.green,
	blue: macchiato.blue,
	mauve: macchiato.mauve,
	muted: macchiato.overlay1,
}

const noticeColor: Record<NoticeTone, string> = {
	info: macchiato.text,
	success: macchiato.green,
	warning: macchiato.yellow,
	error: macchiato.red,
}

const riskColor: Record<SupervisorAction["risk"], string> = {
	"read-only": macchiato.overlay1,
	reversible: macchiato.blue,
	destructive: macchiato.red,
}

const BADGE_WIDTH = 15
const DETAIL_ROWS = 9

/** Truncate or pad to an exact display width. */
const fit = (text: string, width: number) => {
	if (width <= 0) return ""
	if (Bun.stringWidth(text) <= width)
		return text + " ".repeat(width - Bun.stringWidth(text))
	let result = ""
	for (const character of text) {
		if (Bun.stringWidth(result + character) > width - 1) break
		result += character
	}
	return `${result}…${" ".repeat(Math.max(0, width - 1 - Bun.stringWidth(result)))}`
}

const span = (text: string, fg?: string) => (
	<span style={{ fg } as TextNodeOptions}>{text}</span>
)

type Row =
	| { readonly kind: "group"; readonly label: string; readonly detail: string }
	| {
			readonly kind: "item"
			readonly item: SuperviseItem
			readonly index: number
	  }

const isQuestion = (key: { name: string; sequence: string }) =>
	key.name === "?" || key.sequence === "?"

export const SupervisorApp = (props: {
	readonly model: SuperviseModel | null
	readonly status: SupervisorStatus
	readonly notice: SupervisorNotice | null
	readonly modal: Modal | null
	readonly setModal: (modal: Modal | null) => void
	readonly handlers: SupervisorHandlers
}) => {
	const dimensions = useTerminalDimensions()
	const [selectedKey, setSelectedKey] = createSignal<string | null>(null)
	const [selectedActionId, setSelectedActionId] = createSignal<string | null>(
		null,
	)
	/** A refresh changed the selection; the next Enter only acknowledges it. */
	const [guard, setGuard] = createSignal(false)
	const [selectionNotice, setSelectionNotice] = createSignal<string | null>(
		null,
	)
	const items = createMemo(() =>
		(props.model?.groups ?? []).flatMap((group) => group.items),
	)
	const selectedIndex = createMemo(() =>
		items().findIndex((item) => item.key === selectedKey()),
	)
	const selected = () => items()[selectedIndex()] ?? null
	const selectedAction = () => {
		const actions = selected()?.actions ?? []
		return (
			actions.find((action) => action.id === selectedActionId()) ??
			actions[0] ??
			null
		)
	}
	let last: { index: number; label: string; actionTitle: string | null } = {
		index: 0,
		label: "",
		actionTitle: null,
	}
	createEffect(() => {
		const item = selected()
		if (item)
			last = {
				index: selectedIndex(),
				label: item.label,
				actionTitle: selectedAction()?.title ?? null,
			}
	})
	// Keep the selection on the same item and action across refreshes; when
	// either disappears, move to a neighbour and say so.
	createEffect(() => {
		const list = items()
		untrack(() => {
			if (!list.length) return
			const key = selectedKey()
			const index = list.findIndex((item) => item.key === key)
			if (key === null) {
				setSelectedKey(list[0]!.key)
				return
			}
			if (index < 0) {
				const neighbour = list[Math.min(last.index, list.length - 1)]!
				setSelectedKey(neighbour.key)
				setSelectedActionId(null)
				setGuard(true)
				setSelectionNotice(
					`${last.label} is gone; selected ${neighbour.label} instead`,
				)
				return
			}
			const actionId = selectedActionId()
			if (
				actionId !== null &&
				!list[index]!.actions.some((action) => action.id === actionId)
			) {
				setSelectedActionId(null)
				setGuard(true)
				setSelectionNotice(
					`${last.actionTitle ?? "The selected action"} is no longer offered`,
				)
			}
		})
	})
	const userMoved = () => {
		setGuard(false)
		setSelectionNotice(null)
	}
	const select = (index: number) => {
		const list = items()
		if (!list.length) return
		const next = list[Math.max(0, Math.min(list.length - 1, index))]!
		if (next.key !== selected()?.key) setSelectedActionId(null)
		setSelectedKey(next.key)
		userMoved()
	}
	const selectAction = (index: number) => {
		const actions = selected()?.actions ?? []
		const action = actions[index]
		if (!action) return
		setSelectedActionId(action.id)
		userMoved()
	}
	const moveAction = (offset: number) => {
		const actions = selected()?.actions ?? []
		if (!actions.length) return
		const current = Math.max(0, actions.indexOf(selectedAction()!))
		selectAction((current + offset + actions.length) % actions.length)
	}
	const cancelModal = () => {
		const modal = props.modal
		props.setModal(null)
		if (modal?.kind === "confirm") modal.resolve(DECLINED)
		else if (modal?.kind === "text" || modal?.kind === "choose")
			modal.resolve(null)
	}
	const quit = () => {
		cancelModal()
		props.handlers.onQuit()
	}

	useKeyboard((key) => {
		if (key.ctrl && key.name === "c") {
			key.preventDefault()
			key.stopPropagation()
			quit()
			return
		}
		// A held key must never run or confirm anything; text entry keeps repeats.
		if (
			key.repeated &&
			(key.name === "return" ||
				(props.modal?.kind !== "text" && props.modal?.kind !== "choose"))
		) {
			key.preventDefault()
			key.stopPropagation()
			return
		}
		const modal = props.modal
		if (modal) {
			if (modal.kind === "help") {
				if (key.name === "escape" || isQuestion(key)) {
					key.stopPropagation()
					props.setModal(null)
				}
				return
			}
			if (modal.kind !== "confirm") return
			key.stopPropagation()
			if (key.name === "escape" || (modal.stage === 2 && key.name === "n")) {
				cancelModal()
				return
			}
			if (
				modal.stage === 1 &&
				key.name === "return" &&
				Date.now() - modal.openedAt >= CONFIRM_DELAY_MS
			) {
				if (modal.request.destructive) props.setModal({ ...modal, stage: 2 })
				else {
					props.setModal(null)
					modal.resolve({ confirmed: true, destructiveConfirmed: false })
				}
				return
			}
			if (modal.stage === 2 && key.name === "y" && !key.ctrl && !key.meta) {
				props.setModal(null)
				modal.resolve({ confirmed: true, destructiveConfirmed: true })
			}
			return
		}
		if (key.propagationStopped) return
		const handled = () => {
			key.preventDefault()
			key.stopPropagation()
		}
		if (
			key.name === "down" ||
			(key.ctrl && key.name === "n") ||
			(!key.ctrl && !key.meta && key.name === "j")
		) {
			handled()
			select(selectedIndex() + 1)
			return
		}
		if (
			key.name === "up" ||
			(key.ctrl && key.name === "p") ||
			(!key.ctrl && !key.meta && key.name === "k")
		) {
			handled()
			select(selectedIndex() - 1)
			return
		}
		if (key.name === "home") {
			handled()
			select(0)
			return
		}
		if (key.name === "end") {
			handled()
			select(items().length - 1)
			return
		}
		if (key.name === "right" || (key.name === "tab" && !key.shift)) {
			handled()
			moveAction(1)
			return
		}
		if (key.name === "left" || (key.name === "tab" && key.shift)) {
			handled()
			moveAction(-1)
			return
		}
		if (isQuestion(key)) {
			handled()
			props.setModal({ kind: "help" })
			return
		}
		if (key.ctrl || key.meta) return
		const item = selected()
		if (/^[1-9]$/.test(key.name)) {
			handled()
			selectAction(Number(key.name) - 1)
			return
		}
		switch (key.name) {
			case "return": {
				handled()
				if (guard()) {
					setGuard(false)
					setSelectionNotice(
						`Selection changed: ${selected()?.label ?? "nothing"} · ${selectedAction()?.title ?? "no action"}. Press Enter again to run.`,
					)
					return
				}
				const action = selectedAction()
				if (item && action && !props.status.busy)
					props.handlers.onExecute(item, action)
				return
			}
			case "f":
				handled()
				if (item && !props.status.busy) props.handlers.onFocus(item)
				return
			case "r":
				handled()
				props.handlers.onRefresh()
				return
			case "e":
				handled()
				if (!props.status.busy) props.handlers.onEditPrompt(item)
				return
			case "s":
				handled()
				if (item && !props.status.busy) props.handlers.onSnooze(item)
				return
			case "d":
				handled()
				if (item && !props.status.busy) props.handlers.onDismiss(item)
				return
		}
	})

	const width = () => dimensions().width
	const detailRows = () =>
		Math.max(0, Math.min(DETAIL_ROWS, dimensions().height - 8))
	const listRows = () => Math.max(1, dimensions().height - 3 - detailRows())
	const rows = createMemo<Row[]>(() => {
		let index = 0
		return (props.model?.groups ?? []).flatMap((group) => [
			{
				kind: "group" as const,
				label: group.label,
				detail: group.error
					? `unavailable: ${group.error}`
					: `${group.items.length}`,
			},
			...group.items.map((item) => ({
				kind: "item" as const,
				item,
				index: index++,
			})),
		])
	})
	const visibleRows = createMemo(() => {
		const all = rows()
		const count = listRows()
		const at = all.findIndex(
			(row) => row.kind === "item" && row.index === selectedIndex(),
		)
		const start = Math.min(
			Math.max(0, at - Math.floor(count / 2)),
			Math.max(0, all.length - count),
		)
		return all.slice(start, start + count)
	})
	const labelWidth = () => Math.min(32, Math.max(12, Math.floor(width() / 5)))
	const locationWidth = () => Math.min(28, Math.max(0, Math.floor(width() / 6)))

	const header = () => {
		const model = props.model
		const parts = [
			props.status.live ? "● live" : "○ polling",
			model ? `${model.total} item${model.total === 1 ? "" : "s"}` : "loading",
			...(model?.snoozed ? [`${model.snoozed} snoozed`] : []),
			...(model?.dismissed ? [`${model.dismissed} dismissed`] : []),
			...(props.status.refreshing
				? ["refreshing…"]
				: props.status.updatedAt
					? [props.status.updatedAt.toLocaleTimeString()]
					: []),
		]
		return parts.join(" · ")
	}
	const footer = () =>
		props.status.busy
			? "working… · ? help · C-c quit"
			: SUPERVISOR_BINDINGS.flatMap((binding) =>
					binding.footer ? [binding.footer] : [],
				).join(" · ")

	const ItemRow = (rowProps: { item: SuperviseItem; index: number }) => {
		const active = () => rowProps.index === selectedIndex()
		return (
			<text
				height={1}
				wrapMode="none"
				bg={active() ? macchiato.surface1 : macchiato.base}
				fg={active() ? macchiato.text : macchiato.subtext0}
			>
				{span(active() ? "▌ " : "  ", macchiato.blue)}
				{span(
					fit(rowProps.item.badge.label, BADGE_WIDTH),
					toneColor[rowProps.item.badge.tone],
				)}
				{span(fit(rowProps.item.label, labelWidth()), macchiato.text)}
				{span(" ")}
				{span(
					fit(rowProps.item.location ?? "", locationWidth()),
					macchiato.overlay1,
				)}
				{span(" ")}
				{span(rowProps.item.summary)}
			</text>
		)
	}

	const Detail = () => (
		<box
			flexDirection="column"
			height={detailRows()}
			flexShrink={0}
			backgroundColor={macchiato.mantle}
			paddingLeft={1}
			paddingRight={1}
		>
			<Show
				when={selected()}
				fallback={
					<text fg={macchiato.overlay1} height={1}>
						{props.model ? "Nothing needs attention." : "Loading…"}
					</text>
				}
			>
				{(item) => (
					<>
						<text height={1} wrapMode="none" fg={macchiato.text}>
							{span(`${item().badge.label}  `, toneColor[item().badge.tone])}
							{span(`${item().label} — ${item().summary}`)}
						</text>
						<text height={1} wrapMode="none" fg={macchiato.overlay1}>
							{[
								item().location,
								item().subject.pullRequest?.url,
								item().subject.ticket?.key ?? item().subject.ticket?.url,
							]
								.filter(Boolean)
								.join("  ·  ") || " "}
						</text>
						<Show
							when={item().actions.length}
							fallback={
								<text height={1} fg={macchiato.overlay1}>
									No actions available.
								</text>
							}
						>
							<For
								each={item().actions.slice(0, Math.max(0, detailRows() - 3))}
							>
								{(action, index) => {
									const active = () => action === selectedAction()
									return (
										<text
											height={1}
											wrapMode="none"
											bg={active() ? macchiato.surface0 : macchiato.mantle}
											fg={active() ? macchiato.text : macchiato.subtext0}
										>
											{span(active() ? "▸ " : "  ", macchiato.blue)}
											{span(`${index() + 1}  `, macchiato.overlay1)}
											{span(fit(action.title, 44))}
											{span(` ${action.risk}`, riskColor[action.risk])}
										</text>
									)
								}}
							</For>
							<text height={1} wrapMode="none" fg={macchiato.overlay0}>
								{selectedAction()?.rationale ?? ""}
							</text>
						</Show>
					</>
				)}
			</Show>
		</box>
	)

	const ConfirmView = (confirmProps: {
		modal: Extract<Modal, { kind: "confirm" }>
	}) => (
		<box
			flexDirection="column"
			flexGrow={1}
			paddingLeft={2}
			paddingRight={2}
			paddingTop={1}
		>
			<text height={1} wrapMode="none" fg={macchiato.text}>
				{span(`${confirmProps.modal.request.title}  `)}
				{span(
					confirmProps.modal.request.risk,
					riskColor[confirmProps.modal.request.risk],
				)}
			</text>
			<text fg={macchiato.subtext0} wrapMode="word">
				{confirmProps.modal.request.rationale}
			</text>
			<box height={1} flexShrink={0} />
			<text height={1} fg={macchiato.blue}>
				Will run:
			</text>
			<For each={confirmProps.modal.request.preview}>
				{(line) => (
					<text fg={macchiato.text} wrapMode="char">
						{`  ${line}`}
					</text>
				)}
			</For>
			<box height={1} flexShrink={0} />
			<text height={1} wrapMode="none">
				{confirmProps.modal.stage === 2
					? span(
							"Destructive: press y to confirm · n or esc cancel",
							macchiato.red,
						)
					: span(
							confirmProps.modal.request.destructive
								? "enter continue · esc cancel"
								: "enter confirm · esc cancel",
							macchiato.overlay1,
						)}
			</text>
		</box>
	)

	const HelpView = () => (
		<box
			flexDirection="column"
			flexGrow={1}
			paddingLeft={2}
			paddingRight={2}
			paddingTop={1}
		>
			<text height={1} fg={macchiato.blue}>
				Keys
			</text>
			<For each={SUPERVISOR_BINDINGS}>
				{(binding) => (
					<text height={1} wrapMode="none">
						{span(fit(binding.keys, 20), macchiato.text)}
						{span(binding.description, macchiato.subtext0)}
					</text>
				)}
			</For>
			<box height={1} flexShrink={0} />
			<text fg={macchiato.overlay1} wrapMode="word">
				Every action shows exactly what it runs and rechecks its preconditions
				against fresh state before running. Destructive actions need a second
				confirmation.
			</text>
		</box>
	)

	return (
		<box
			flexDirection="column"
			width="100%"
			height="100%"
			backgroundColor={macchiato.base}
		>
			<box
				flexDirection="row"
				height={1}
				flexShrink={0}
				paddingLeft={1}
				paddingRight={1}
				backgroundColor={macchiato.surface0}
			>
				<text fg={macchiato.blue} wrapMode="none" flexShrink={0}>
					Agency Supervisor
				</text>
				<box flexGrow={1} minWidth={1} />
				<text
					fg={props.status.live ? macchiato.green : macchiato.overlay1}
					wrapMode="none"
					flexShrink={0}
				>
					{header()}
				</text>
			</box>
			<Show
				when={props.modal}
				keyed
				fallback={
					<>
						<box flexDirection="column" flexGrow={1} minHeight={0}>
							<For
								each={visibleRows()}
								fallback={
									<text fg={macchiato.overlay1} paddingLeft={2}>
										{props.model
											? "Nothing needs attention."
											: "Gathering attention signals…"}
									</text>
								}
							>
								{(row) =>
									row.kind === "group" ? (
										<text height={1} wrapMode="none" fg={macchiato.mauve}>
											{span(` ${row.label}`)}
											{span(`  ${row.detail}`, macchiato.overlay1)}
										</text>
									) : (
										<ItemRow item={row.item} index={row.index} />
									)
								}
							</For>
						</box>
						<Detail />
					</>
				}
			>
				{(current) =>
					current.kind === "help" ? (
						<HelpView />
					) : current.kind === "confirm" ? (
						<ConfirmView modal={current} />
					) : current.kind === "text" ? (
						<box flexGrow={1} minHeight={0} paddingLeft={1} paddingRight={1}>
							<InteractiveTextPrompt
								fullScreen
								embedded
								prompt={current.prompt}
								onDone={(value) => {
									props.setModal(null)
									current.resolve(value)
								}}
								onQuit={props.handlers.onQuit}
							/>
						</box>
					) : (
						<box flexGrow={1} minHeight={0} paddingLeft={1} paddingRight={1}>
							<InteractiveSelectPrompt
								embedded
								reservedRows={3}
								prompt={current.prompt}
								choices={current.choices}
								onDone={(value) => {
									props.setModal(null)
									current.resolve(value)
								}}
								onQuit={props.handlers.onQuit}
							/>
						</box>
					)
				}
			</Show>
			<text
				height={1}
				flexShrink={0}
				wrapMode="none"
				paddingLeft={1}
				fg={
					selectionNotice()
						? macchiato.yellow
						: props.notice
							? noticeColor[props.notice.tone]
							: macchiato.overlay1
				}
			>
				{selectionNotice() ?? props.notice?.text ?? " "}
			</text>
			<text
				height={1}
				flexShrink={0}
				wrapMode="none"
				paddingLeft={1}
				fg={macchiato.overlay1}
				bg={macchiato.mantle}
			>
				{footer()}
			</text>
		</box>
	)
}

const shutdown = async (renderer: CliRenderer) => {
	try {
		await renderer.idle()
	} finally {
		renderer.destroy()
	}
}

/** Own the terminal for a long-lived supervisor session. */
export const createSupervisorSession = async (handlers: SupervisorHandlers) => {
	const [model, setModel] = createSignal<SuperviseModel | null>(null)
	const [status, setStatus] = createSignal<SupervisorStatus>({
		live: false,
		refreshing: true,
		busy: false,
		updatedAt: null,
	})
	const [notice, setNotice] = createSignal<SupervisorNotice | null>(null)
	const [modal, setModal] = createSignal<Modal | null>(null)
	let closed = false
	let quitting = false
	const quit = () => {
		// An open dialog is cancelled before the quit is queued.
		dismissModal()
		if (quitting) return
		quitting = true
		handlers.onQuit()
	}
	const renderer = await createCliRenderer({
		...interactiveSelectRendererConfig,
		onDestroy: () => {
			const external = !closed
			closed = true
			dismissModal()
			if (external) quit()
		},
	})
	const dismissModal = () => {
		const current = modal()
		setModal(null)
		if (current?.kind === "confirm") current.resolve(DECLINED)
		else if (current?.kind === "text" || current?.kind === "choose")
			current.resolve(null)
	}
	try {
		await render(
			() => (
				<SupervisorApp
					model={model()}
					status={status()}
					notice={notice()}
					modal={modal()}
					setModal={setModal}
					handlers={{ ...handlers, onQuit: quit }}
				/>
			),
			renderer,
		)
	} catch (error) {
		await shutdown(renderer)
		throw error
	}
	const open = <T,>(make: (resolve: (value: T) => void) => Modal, empty: T) => {
		if (closed) return Promise.resolve(empty)
		dismissModal()
		return new Promise<T>((resolve) => {
			setModal(make(resolve))
			renderer.requestRender()
		})
	}
	const changed = () => renderer.requestRender()
	return {
		update: (next: SuperviseModel) => {
			setModel(next)
			changed()
		},
		status: (next: Partial<SupervisorStatus>) => {
			setStatus({ ...status(), ...next })
			changed()
		},
		notice: (text: string, tone: NoticeTone = "info") => {
			setNotice({ text, tone })
			changed()
		},
		confirm: (request: ConfirmRequest) =>
			open<SupervisorConfirmation>(
				(resolve) => ({
					kind: "confirm",
					request,
					stage: 1,
					openedAt: Date.now(),
					resolve,
				}),
				DECLINED,
			),
		text: (prompt: string) =>
			open<string | null>(
				(resolve) => ({ kind: "text", prompt, resolve }),
				null,
			),
		choose: (prompt: string, choices: readonly InteractiveChoice[]) =>
			open<string | null>(
				(resolve) => ({ kind: "choose", prompt, choices, resolve }),
				null,
			),
		/** Hand the terminal to a child process, such as $EDITOR. */
		suspend: () => renderer.suspend(),
		resume: () => {
			renderer.resume()
			changed()
		},
		close: async () => {
			if (closed) return
			closed = true
			dismissModal()
			await shutdown(renderer)
		},
	}
}

export type SupervisorSession = Awaited<
	ReturnType<typeof createSupervisorSession>
>
