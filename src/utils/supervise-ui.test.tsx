import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import type { SupervisorAction } from "../attention-schema"
import type { SuperviseItem, SuperviseModel } from "../workbase/supervise-view"
import { SupervisorApp, type SupervisorHandlers } from "./supervise-ui"

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
		onEditPrompt: (target) => events.push(`edit ${target?.key}`),
		onSnooze: (target) => events.push(`snooze ${target.key}`),
		onDismiss: (target) => events.push(`dismiss ${target.key}`),
		onQuit: () => events.push("quit"),
	}
	const [modal, setModal] =
		createSignal<Parameters<typeof SupervisorApp>[0]["modal"]>(null)
	const rendered = await testRender(
		() => (
			<SupervisorApp
				model={model}
				status={{ live: true, refreshing: false, busy: false, updatedAt: null }}
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
	return { ...rendered, events, setModal, modal, frame }
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
			view.mockInput.typeText("q")
			await view.waitFor(() => view.events.length >= 7)
			expect(view.events).toEqual([
				"run beta b1",
				"run alpha a2",
				"focus alpha",
				"snooze alpha",
				"dismiss alpha",
				"edit alpha",
				"refresh",
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
			const answers: boolean[] = []
			view.setModal({
				kind: "confirm",
				stage: 1,
				request: {
					title: "Close tab w1:t1",
					rationale: "Done.",
					risk: "destructive",
					preview: ["herdr: close tab w1:t1"],
					destructive: true,
				},
				resolve: (value) => answers.push(value),
			})
			const first = await view.frame()
			expect(first).toContain("herdr: close tab w1:t1")
			expect(first).toContain("enter continue")
			view.mockInput.pressEnter()
			expect(await view.frame()).toContain("press y to confirm")
			expect(answers).toEqual([])
			view.mockInput.typeText("n")
			expect(answers).toEqual([])
			view.mockInput.typeText("y")
			await view.waitFor(() => answers.length > 0)
			expect(answers).toEqual([true])
			expect(view.modal()).toBeNull()
			expect(view.events).toEqual([])
		} finally {
			view.renderer.destroy()
		}
	})
})
