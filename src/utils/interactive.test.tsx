import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import {
	fuzzyChoices,
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

	test("ranks case-insensitive fuzzy matches", () => {
		const choices = [
			{ key: "nested", label: "Manage Agency" },
			{ key: "prefix", label: "Agency" },
			{ key: "other", label: "Website" },
		]

		expect(fuzzyChoices(choices, "AG").map((choice) => choice.key)).toEqual([
			"prefix",
			"nested",
		])
		expect(fuzzyChoices(choices, "mgy").map((choice) => choice.key)).toEqual([
			"nested",
		])
		expect(fuzzyChoices(choices, "zzz")).toEqual([])
	})

	test("selects choices with ctrl-p, ctrl-n, and arrow navigation", async () => {
		const selectAfter = async (key: "p" | "n" | "up" | "down") => {
			let selected: string | null | undefined
			const setup = await testRender(
				() => (
					<InteractiveSelectPrompt
						prompt="Repository"
						choices={[
							{ key: "agency", label: "agency" },
							{ key: "web", label: "web" },
							{ key: "docs", label: "docs" },
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
				if (key === "up" || key === "down") {
					setup.mockInput.pressArrow(key)
				} else {
					setup.mockInput.pressKey(key, { ctrl: true })
				}
				setup.mockInput.pressEnter()
				await setup.waitFor(() => selected !== undefined)
				return selected
			} finally {
				setup.renderer.destroy()
			}
		}

		expect(await selectAfter("p")).toBe("docs")
		expect(await selectAfter("n")).toBe("web")
		expect(await selectAfter("up")).toBe("docs")
		expect(await selectAfter("down")).toBe("web")
	})

	test("uses printable j, k, and q characters as the fuzzy query", async () => {
		for (const query of ["j", "k", "q"]) {
			let selected: string | null | undefined
			const setup = await testRender(
				() => (
					<InteractiveSelectPrompt
						prompt="Repository"
						choices={[
							{ key: query, label: `${query} target` },
							{ key: "other", label: "Other" },
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
				await setup.mockInput.typeText(query)
				setup.mockInput.pressEnter()
				await setup.waitFor(() => selected !== undefined)
				expect(selected).toBe(query)
			} finally {
				setup.renderer.destroy()
			}
		}
	})

	test("does not select an empty result and supports ctrl-u editing", async () => {
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
			await setup.mockInput.typeText("zzz")
			setup.mockInput.pressEnter()
			await Bun.sleep(0)
			expect(selected).toBeUndefined()
			setup.mockInput.pressKey("u", { ctrl: true })
			await setup.mockInput.typeText("web")
			setup.mockInput.pressEnter()
			await setup.waitFor(() => selected !== undefined)
			expect(selected).toBe("web")
		} finally {
			setup.renderer.destroy()
		}
	})

	test("resets and navigates selection after filtering", async () => {
		let selected: string | null | undefined
		const setup = await testRender(
			() => (
				<InteractiveSelectPrompt
					prompt="Repository"
					choices={[
						{ key: "agency", label: "agency" },
						{ key: "web-one", label: "web one" },
						{ key: "web-two", label: "web two" },
						{ key: "docs", label: "docs" },
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
			setup.mockInput.pressArrow("down")
			setup.mockInput.pressArrow("down")
			setup.mockInput.pressArrow("down")
			await setup.mockInput.typeText("web")
			setup.mockInput.pressKey("n", { ctrl: true })
			setup.mockInput.pressEnter()
			await setup.waitFor(() => selected !== undefined)
			expect(selected).toBe("web-two")
		} finally {
			setup.renderer.destroy()
		}
	})

	test("submits text and cancels with ctrl-c or escape", async () => {
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

		let escaped: string | null | undefined
		const escape = await testRender(
			() => (
				<InteractiveSelectPrompt
					prompt="Cancel"
					choices={[{ key: "one", label: "One" }]}
					onDone={(value) => {
						escaped = value
					}}
				/>
			),
			{ width: 60, height: 4, kittyKeyboard: true },
		)
		try {
			await escape.renderer.setupTerminal()
			await escape.renderOnce()
			await Bun.sleep(0)
			escape.mockInput.pressEscape()
			await escape.waitFor(() => escaped !== undefined)
			expect(escaped).toBeNull()
		} finally {
			escape.renderer.destroy()
		}
	})
})
