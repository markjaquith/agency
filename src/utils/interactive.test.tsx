import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import {
	InteractiveSelectPrompt,
	InteractiveTextPrompt,
	interactiveRendererConfig,
} from "./interactive"

describe("OpenTUI interaction", () => {
	test("uses the split-footer renderer contract", () => {
		expect(interactiveRendererConfig).toMatchObject({
			screenMode: "split-footer",
			footerHeight: 4,
			externalOutputMode: "capture-stdout",
			clearOnShutdown: false,
		})
	})

	test("selects choices with keyboard navigation", async () => {
		let selected: string | null | undefined
		const setup = await testRender(
			() => (
				<InteractiveSelectPrompt
					prompt="Repository"
					choices={[
						{ key: "agency", label: "agency" },
						{ key: "web", label: "web" },
					]}
					onDone={(value) => {
						selected = value
					}}
				/>
			),
			{ width: 60, height: 4 },
		)
		try {
			await setup.renderer.setupTerminal()
			await setup.renderOnce()
			await Bun.sleep(0)
			expect(setup.renderer.keyInput.listenerCount("keypress")).toBeGreaterThan(
				0,
			)
			setup.mockInput.pressArrow("down")
			setup.mockInput.pressEnter()
			await setup.waitFor(() => selected !== undefined)
			expect(selected).toBe("web")
		} finally {
			setup.renderer.destroy()
		}
	})

	test("submits text and cancels with ctrl-c", async () => {
		let submitted: string | null | undefined
		const input = await testRender(
			() => (
				<InteractiveTextPrompt
					prompt="Task ID"
					onDone={(value) => {
						submitted = value
					}}
				/>
			),
			{ width: 60, height: 4 },
		)
		try {
			await input.renderer.setupTerminal()
			await input.renderOnce()
			await Bun.sleep(0)
			expect(input.renderer.keyInput.listenerCount("keypress")).toBeGreaterThan(
				0,
			)
			await input.mockInput.typeText("improve-ui")
			input.mockInput.pressEnter()
			await input.waitFor(() => submitted !== undefined)
			expect(submitted).toBe("improve-ui")
		} finally {
			input.renderer.destroy()
		}

		let cancelled: string | null | undefined
		const select = await testRender(
			() => (
				<InteractiveSelectPrompt
					prompt="Cancel"
					choices={[{ key: "one", label: "One" }]}
					onDone={(value) => {
						cancelled = value
					}}
				/>
			),
			{ width: 60, height: 4 },
		)
		try {
			await select.renderer.setupTerminal()
			await select.renderOnce()
			await Bun.sleep(0)
			select.mockInput.pressCtrlC()
			await select.waitFor(() => cancelled !== undefined)
			expect(cancelled).toBeNull()
		} finally {
			select.renderer.destroy()
		}
	})
})
