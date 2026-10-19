import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import type { SupervisorAction } from "../attention-schema"
import { CONFIRM_DELAY_MS, InteractiveTabbedPrompt } from "./interactive"
import type { SuperviseItem, SuperviseModel } from "../workbase/supervise-view"
import {
	createSupervisorSurface,
	SupervisorApp,
	type SupervisorConfirmation,
	type SupervisorHandlers,
} from "./supervise-tab"

const subject = {
	workbase: { id: null, name: "Main", root: "/work" },
	item: null,
	runtime: [],
	pullRequest: null,
	ticket: null,
}

const action = (
	id: string,
	risk: SupervisorAction["risk"] = "reversible",
): SupervisorAction => ({
	version: 1,
	id,
	type: "open_url",
	title: `Action ${id}`,
	rationale: `Why ${id}`,
	risk,
	subject,
	preconditions: [],
	payload: { url: "https://example.com" },
})

const item = (key: string, actions: SupervisorAction[]): SuperviseItem => ({
	key,
	groupKey: "/work",
	badge: { label: "Needs You", tone: "yellow", rank: 1 },
	label: key,
	location: "Main › tab",
	summary: `${key} summary`,
	subject,
	signals: [],
	actions,
	modelActionIds: [],
	triageActionIds: [],
	triage: null,
	fingerprints: { signal: key, triage: null },
	fingerprint: key,
})

const model: SuperviseModel = {
	generatedAt: "2026-10-16T00:00:00.000Z",
	runtime: { provider: "herdr", available: true, error: null },
	groups: [
		{
			key: "/work",
			label: "Main",
			error: null,
			items: [
				item("alpha", [action("a1"), action("a2", "destructive")]),
				item("beta", [action("b1")]),
			],
		},
	],
	total: 2,
	snoozed: 0,
	dismissed: 0,
}

const setup = async () => {
	const events: string[] = []
	const handlers: SupervisorHandlers = {
		onExecute: (target, chosen) =>
			events.push(`run ${target.key} ${chosen.id}`),
		onFocus: (target) => events.push(`focus ${target.key}`),
		onRefresh: () => events.push("refresh"),
		onTriage: (target) => events.push(`triage ${target?.key ?? "all"}`),
		onEditPrompt: (target) => events.push(`edit ${target?.key}`),
		onSnooze: (target) => events.push(`snooze ${target.key}`),
		onDismiss: (target) => events.push(`dismiss ${target.key}`),
		onQuit: () => events.push("quit"),
	}
	const [modal, setModal] =
		createSignal<Parameters<typeof SupervisorApp>[0]["modal"]>(null)
	const [current, setCurrent] = createSignal<SuperviseModel>(model)
	const rendered = await testRender(
		() => (
			<SupervisorApp
				model={current()}
				status={{
					live: true,
					refreshing: false,
					busy: false,
					updatedAt: null,
					triage: { running: null, startedAt: null, last: null },
				}}
				notice={null}
				modal={modal()}
				setModal={setModal}
				handlers={handlers}
			/>
		),
		{ width: 100, height: 24 },
	)
	await rendered.renderer.setupTerminal()
	await rendered.renderOnce()
	await Bun.sleep(0)
	const frame = async () => {
		await rendered.renderOnce()
		return rendered.captureCharFrame()
	}
	return { ...rendered, events, setModal, modal, frame, setCurrent }
}

describe("supervisor view", () => {
	test("navigates items and actions and runs the selected action", async () => {
		const view = await setup()
		try {
			expect(await view.frame()).toContain("Main  2")
			view.mockInput.typeText("j")
			view.mockInput.pressEnter()
			view.mockInput.typeText("k")
			view.mockInput.pressArrow("right")
			view.mockInput.pressEnter()
			view.mockInput.typeText("1")
			view.mockInput.typeText("f")
			view.mockInput.typeText("s")
			view.mockInput.typeText("d")
			view.mockInput.typeText("e")
			view.mockInput.typeText("r")
			view.mockInput.typeText("R")
			view.mockInput.typeText("q")
			await view.waitFor(() => view.events.length >= 8)
			await view.frame()
			expect(view.events).toEqual([
				"run beta b1",
				"run alpha a2",
				"focus alpha",
				"snooze alpha",
				"dismiss alpha",
				"edit alpha",
				"triage alpha",
				"triage all",
			])
			view.mockInput.pressCtrlC()
			await view.waitFor(() => view.events.includes("quit"))
		} finally {
			view.renderer.destroy()
		}
	})

	test("toggles contextual help with ? and closes it with escape", async () => {
		const view = await setup()
		try {
			view.mockInput.typeText("?")
			expect(await view.frame()).toContain("Choose an action by number")
			view.mockInput.typeText("j")
			view.mockInput.pressEscape()
			// A standalone Escape waits for the terminal decoder's ambiguity timeout.
			await Bun.sleep(30)
			const frame = await view.frame()
			expect(frame).not.toContain("Choose an action by number")
			expect(frame).toContain("alpha summary")
			expect(view.events).toEqual([])
		} finally {
			view.renderer.destroy()
		}
	})

	test("requires a second confirmation for destructive actions", async () => {
		const view = await setup()
		try {
			const answers: SupervisorConfirmation[] = []
			view.setModal({
				kind: "confirm",
				stage: 1,
				openedAt: 0,
				request: {
					title: "Close tab w1:t1",
					rationale: "Done.",
					risk: "destructive",
					preview: ["herdr: close tab w1:t1"],
					cwd: "/work",
					destructive: true,
				},
				resolve: (value) => answers.push(value),
			})
			const first = await view.frame()
			expect(first).toContain("herdr: close tab w1:t1")
			expect(first).toContain("in /work")
			expect(first).toContain("enter continue")
			// The Enter guard also counts from when the panel was shown.
			await Bun.sleep(CONFIRM_DELAY_MS + 10)
			view.mockInput.pressEnter()
			expect(await view.frame()).toContain("press y to confirm")
			expect(answers).toEqual([])
			view.mockInput.pressEnter()
			view.mockInput.typeText("x")
			expect(answers).toEqual([])
			view.mockInput.typeText("y")
			await view.waitFor(() => answers.length > 0)
			expect(answers).toEqual([{ confirmed: true, destructiveConfirmed: true }])
			expect(view.modal()).toBeNull()
			expect(view.events).toEqual([])
		} finally {
			view.renderer.destroy()
		}
	})

	const confirm = (
		view: Awaited<ReturnType<typeof setup>>,
		openedAt: number,
		destructive = false,
	) => {
		const answers: SupervisorConfirmation[] = []
		view.setModal({
			kind: "confirm",
			stage: 1,
			openedAt,
			request: {
				title: "Act",
				rationale: "Because.",
				risk: destructive ? "destructive" : "reversible",
				preview: ["open https://example.com"],
				destructive,
			},
			resolve: (value) => answers.push(value),
		})
		return answers
	}

	test("ignores Enter right after a dialog opens, so a double press cannot confirm", async () => {
		const view = await setup()
		try {
			const answers = confirm(view, Date.now())
			await view.frame()
			view.mockInput.pressEnter()
			await view.frame()
			expect(answers).toEqual([])
			expect(view.modal()).not.toBeNull()
			await Bun.sleep(260)
			view.mockInput.pressEnter()
			await view.waitFor(() => answers.length > 0)
			expect(answers).toEqual([
				{ confirmed: true, destructiveConfirmed: false },
			])
			expect(view.events).toEqual([])
		} finally {
			view.renderer.destroy()
		}
	})

	test("n cancels the destructive second confirmation", async () => {
		const view = await setup()
		try {
			const answers = confirm(view, 0, true)
			await view.frame()
			await Bun.sleep(CONFIRM_DELAY_MS + 10)
			view.mockInput.pressEnter()
			await view.frame()
			view.mockInput.typeText("n")
			await view.waitFor(() => answers.length > 0)
			expect(answers).toEqual([
				{ confirmed: false, destructiveConfirmed: false },
			])
		} finally {
			view.renderer.destroy()
		}
	})

	test("C-c cancels an open dialog and quits", async () => {
		const view = await setup()
		try {
			const answers = confirm(view, 0)
			await view.frame()
			view.mockInput.pressCtrlC()
			await view.waitFor(() => view.events.includes("quit"))
			expect(answers).toEqual([
				{ confirmed: false, destructiveConfirmed: false },
			])
			expect(view.modal()).toBeNull()
		} finally {
			view.renderer.destroy()
		}
	})

	test("announces a refresh that moves the selection and holds the next Enter", async () => {
		const view = await setup()
		try {
			view.mockInput.pressArrow("right")
			await view.frame()
			view.setCurrent({
				...model,
				groups: [{ ...model.groups[0]!, items: [model.groups[0]!.items[1]!] }],
			})
			expect(await view.frame()).toContain(
				"alpha is gone; selected beta instead",
			)
			view.mockInput.pressEnter()
			expect(await view.frame()).toContain("Press Enter again to run")
			expect(view.events).toEqual([])
			view.mockInput.pressEnter()
			await view.waitFor(() => view.events.length > 0)
			expect(view.events).toEqual(["run beta b1"])
		} finally {
			view.renderer.destroy()
		}
	})

	test("names the vanished action, not its replacement, after a refresh", async () => {
		const view = await setup()
		try {
			view.mockInput.pressArrow("right")
			await view.frame()
			const alpha = model.groups[0]!.items[0]!
			view.setCurrent({
				...model,
				groups: [
					{
						...model.groups[0]!,
						items: [
							{ ...alpha, actions: [action("t1"), alpha.actions[0]!] },
							model.groups[0]!.items[1]!,
						],
					},
				],
			})
			const frame = await view.frame()
			expect(frame).toContain("Action a2 is no longer offered")
			expect(frame).not.toContain("Action t1 is no longer offered")
			view.mockInput.pressEnter()
			expect(await view.frame()).toContain("Action t1. Press Enter again")
			view.mockInput.pressEnter()
			await view.waitFor(() => view.events.length > 0)
			expect(view.events).toEqual(["run alpha t1"])
		} finally {
			view.renderer.destroy()
		}
	})

	test("ignores held-key repeats", async () => {
		const view = await setup()
		try {
			view.renderer.keyInput.processParsedKey({
				name: "return",
				ctrl: false,
				meta: false,
				shift: false,
				option: false,
				sequence: "\r",
				number: false,
				raw: "\r",
				eventType: "press",
				source: "raw",
				repeated: true,
			})
			await view.frame()
			expect(view.events).toEqual([])
			view.mockInput.pressEnter()
			await view.waitFor(() => view.events.length > 0)
			expect(view.events).toEqual(["run alpha a1"])
		} finally {
			view.renderer.destroy()
		}
	})

	test("keeps the pinned action when a refresh changes the default", async () => {
		const view = await setup()
		try {
			await view.frame()
			const alpha = model.groups[0]!.items[0]!
			view.setCurrent({
				...model,
				groups: [
					{
						...model.groups[0]!,
						items: [
							{ ...alpha, actions: [action("t1"), ...alpha.actions] },
							model.groups[0]!.items[1]!,
						],
					},
				],
			})
			await view.frame()
			view.mockInput.pressEnter()
			await view.waitFor(() => view.events.length > 0)
			expect(view.events).toEqual(["run alpha a1"])
		} finally {
			view.renderer.destroy()
		}
	})

	test("flags model-written actions in the confirmation", async () => {
		const view = await setup()
		try {
			view.setModal({
				kind: "confirm",
				stage: 1,
				openedAt: 0,
				request: {
					source: "model",
					title: "Run",
					rationale: "Because.",
					risk: "destructive",
					preview: ["true"],
					destructive: true,
				},
				resolve: () => {},
			})
			const frame = await view.frame()
			expect(frame).toContain("Written by the triage model")
			expect(frame.indexOf("Written by the triage model")).toBeLessThan(
				frame.indexOf("Will run:"),
			)
		} finally {
			view.renderer.destroy()
		}
	})
})

describe("Supervise tab in the act frame", () => {
	const frameTabs = [
		{
			id: "workstream",
			label: "Workstream",
			prompt: "",
			choices: [
				{ key: "a", label: "alpha task" },
				{ key: "b", label: "beta task" },
			],
		},
		{
			id: "workbase",
			label: "Workbase",
			prompt: "",
			choices: [{ key: "create", label: "Create work" }],
		},
		{ id: "supervise", label: "Supervise", prompt: "", choices: [] },
	]

	const mount = async (surface: ReturnType<typeof createSupervisorSurface>) => {
		const changes: number[] = []
		let submitted: string | null | undefined
		const rendered = await testRender(
			() => (
				<InteractiveTabbedPrompt
					tabs={frameTabs}
					panels={{ supervise: surface.panel }}
					onTabChange={(index) => changes.push(index)}
					onDone={(value) => {
						submitted = value
					}}
				/>
			),
			{ width: 100, height: 24 },
		)
		await rendered.renderer.setupTerminal()
		await rendered.renderOnce()
		await Bun.sleep(0)
		const frame = async () => {
			await rendered.renderOnce()
			return rendered.captureCharFrame()
		}
		return { ...rendered, changes, frame, submitted: () => submitted }
	}

	test("cycles tabs both ways and keeps Workstream's filter and selection while Supervise refreshes", async () => {
		const selected: (string | null)[] = []
		const surface = createSupervisorSurface({
			onSelect: (item) => selected.push(item?.key ?? null),
		})
		surface.ui.update(model)
		const view = await mount(surface)
		try {
			await view.mockInput.typeText("beta")
			// Background refreshes land while the user is typing elsewhere.
			for (let index = 0; index < 3; index++)
				surface.ui.update({ ...model, generatedAt: `refresh-${index}` })
			surface.ui.status({ refreshing: true })
			let frame = await view.frame()
			expect(frame).toContain("▌ beta task")
			expect(frame).not.toContain("alpha task")
			view.mockInput.pressTab({ shift: true })
			frame = await view.frame()
			expect(frame).toContain("alpha summary")
			expect(view.changes).toEqual([2])
			// The automatic first selection is not the user's choice.
			expect(selected).toEqual([])
			view.mockInput.typeText("j")
			await view.frame()
			expect(selected).toEqual(["beta"])
			// A refresh that reorders items keeps the selection on the same item.
			surface.ui.update({
				...model,
				groups: [
					{
						...model.groups[0]!,
						items: [model.groups[0]!.items[1]!, model.groups[0]!.items[0]!],
					},
				],
			})
			frame = await view.frame()
			expect(frame).toMatch(/▌ Needs You\s+beta/)
			expect(frame).not.toContain("is gone")
			// Refreshes never report a selection, so they never move workbases.
			expect(selected).toEqual(["beta"])
			view.mockInput.pressTab()
			frame = await view.frame()
			expect(view.changes).toEqual([2, 0])
			expect(frame).toContain("▌ beta task")
			expect(frame).not.toContain("alpha task")
			view.mockInput.pressEnter()
			await view.waitFor(() => view.submitted() !== undefined)
			expect(view.submitted()).toBe("b")
		} finally {
			view.renderer.destroy()
		}
	})

	test("keeps Tab inside an open Supervise dialog and ignores keys while hidden", async () => {
		const executed: string[] = []
		const surface = createSupervisorSurface()
		surface.attach({
			onExecute: (item, action) => executed.push(`${item.key} ${action.id}`),
			onFocus: () => {},
			onRefresh: () => {},
			onTriage: () => {},
			onEditPrompt: () => {},
			onSnooze: () => {},
			onDismiss: () => {},
			onQuit: () => {},
		})
		surface.ui.update(model)
		const view = await mount(surface)
		try {
			// Workstream is showing: Supervise's keys do nothing.
			view.mockInput.typeText("f")
			await view.frame()
			expect(executed).toEqual([])
			view.mockInput.pressTab({ shift: true })
			await view.frame()
			const answer = surface.ui.confirm({
				title: "Close tab w1:t1",
				rationale: "Done.",
				risk: "destructive",
				preview: ["herdr: close tab w1:t1"],
				destructive: true,
			})
			expect(await view.frame()).toContain("herdr: close tab w1:t1")
			view.mockInput.pressTab()
			expect(await view.frame()).toContain("herdr: close tab w1:t1")
			expect(view.changes).toEqual([2])
			view.mockInput.pressEscape()
			await Bun.sleep(30)
			expect(await answer).toEqual({
				confirmed: false,
				destructiveConfirmed: false,
			})
			view.mockInput.pressTab()
			await view.frame()
			expect(view.changes).toEqual([2, 0])
		} finally {
			view.renderer.destroy()
		}
	})

	test("a dialog opened while Supervise was hidden waits out the Enter guard once shown", async () => {
		const surface = createSupervisorSurface()
		surface.ui.update(model)
		const view = await mount(surface)
		try {
			const answer = surface.ui.confirm({
				title: "Focus",
				rationale: "Look.",
				risk: "reversible",
				preview: ["herdr: focus pane w1:p1"],
				destructive: false,
			})
			await Bun.sleep(CONFIRM_DELAY_MS + 10)
			view.mockInput.pressTab({ shift: true })
			await view.frame()
			view.mockInput.pressEnter()
			await view.frame()
			let settled = false
			void answer.then(() => {
				settled = true
			})
			await Bun.sleep(0)
			expect(settled).toBe(false)
			await Bun.sleep(CONFIRM_DELAY_MS + 10)
			view.mockInput.pressEnter()
			expect(await answer).toEqual({
				confirmed: true,
				destructiveConfirmed: false,
			})
		} finally {
			view.renderer.destroy()
		}
	})
})
