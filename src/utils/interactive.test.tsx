import { describe, expect, test } from "bun:test"
import { KeyCodes, type MockInput } from "@opentui/core/testing"
import { testRender } from "@opentui/solid"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
	fuzzyChoices,
	hierarchyPrefix,
	InteractiveSelectPrompt,
	InteractiveTextPrompt,
	interactiveRendererConfig,
	interactiveSelectRendererConfig,
} from "./interactive"

const submitEditedText = async (
	edit: (input: MockInput) => void | Promise<void>,
) => {
	let submitted: string | null | undefined
	const setup = await testRender(
		() => (
			<InteractiveTextPrompt
				prompt="Text"
				onDone={(value) => {
					submitted = value
				}}
			/>
		),
		{ width: 60, height: 4 },
	)
	try {
		await setup.renderer.setupTerminal()
		await setup.renderOnce()
		await Bun.sleep(0)
		await edit(setup.mockInput)
		setup.mockInput.pressEnter()
		await setup.waitFor(() => submitted !== undefined)
		return submitted
	} finally {
		setup.renderer.destroy()
	}
}

describe("OpenTUI interaction", () => {
	test("selects the Solid JSX runtime without the project preload", async () => {
		const source = await Bun.file(
			new URL("./interactive.tsx", import.meta.url),
		).text()
		const root = await mkdtemp(join(tmpdir(), "agency-interactive-jsx-"))
		const entrypoint = join(
			root,
			"node_modules",
			"@markjaquith",
			"agency",
			"interactive.tsx",
		)
		await mkdir(dirname(entrypoint), { recursive: true })
		await writeFile(entrypoint, source)

		try {
			const result = await Bun.build({
				entrypoints: [entrypoint],
				packages: "external",
				target: "bun",
			})
			expect(result.success).toBeTrue()
			const output = await result.outputs[0]!.text()
			expect(output).toContain("@opentui/solid/jsx-dev-runtime")
			expect(output).not.toContain("react/jsx-dev-runtime")
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	test("uses the split-footer renderer contract", () => {
		expect(interactiveRendererConfig).toMatchObject({
			screenMode: "split-footer",
			footerHeight: 5,
			externalOutputMode: "capture-stdout",
			clearOnShutdown: false,
		})
	})

	test("uses the full alternate screen for selectors", () => {
		expect(interactiveSelectRendererConfig).toMatchObject({
			screenMode: "alternate-screen",
			externalOutputMode: "passthrough",
			clearOnShutdown: false,
		})
	})

	test("fills the available rows and keeps the selection visible after resize", async () => {
		const setup = await testRender(
			() => (
				<InteractiveSelectPrompt
					prompt="Work on"
					choices={Array.from({ length: 10 }, (_, index) => ({
						key: String(index),
						label: `choice-${index}`,
					}))}
					onDone={() => undefined}
				/>
			),
			{ width: 40, height: 8 },
		)
		try {
			await setup.renderer.setupTerminal()
			await setup.renderOnce()
			await Bun.sleep(0)

			let frame = setup.captureCharFrame()
			for (let index = 0; index < 6; index++) {
				expect(frame).toContain(`choice-${index}`)
			}
			expect(frame).not.toContain("choice-6")

			for (let index = 0; index < 7; index++) {
				setup.mockInput.pressArrow("down")
			}
			await setup.flush()
			frame = setup.captureCharFrame()
			expect(frame).toContain("choice-4")
			expect(frame).toContain("▌ choice-7")
			expect(frame).toContain("choice-9")

			setup.resize(40, 5)
			await setup.flush()
			frame = setup.captureCharFrame()
			expect(frame).not.toContain("choice-5")
			expect(frame).toContain("choice-6")
			expect(frame).toContain("▌ choice-7")
			expect(frame).toContain("choice-8")
			expect(frame).not.toContain("choice-9")
		} finally {
			setup.renderer.destroy()
		}
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

	test("builds continuous hierarchy connectors for roots, children, and phases", () => {
		const choices = [
			{ key: "epic", label: "epic delivery", depth: 0 },
			{ key: "multi", label: "task multi", depth: 1 },
			{ key: "build", label: "phase build", depth: 2 },
			{ key: "verify", label: "phase verify", depth: 2 },
			{ key: "single", label: "task single", depth: 1 },
			{ key: "empty", label: "epic empty", depth: 0 },
			{ key: "standalone", label: "task standalone", depth: 0 },
		]

		expect(choices.map((_, index) => hierarchyPrefix(choices, index))).toEqual([
			"╭─ ",
			"│  ╭─ ",
			"│  │  ╭─ ",
			"│  │  ╰─ ",
			"│  ╰─ ",
			"├─ ",
			"╰─ ",
		])
		expect(hierarchyPrefix([{ key: "only", label: "Only", depth: 0 }], 0)).toBe(
			"╰─ ",
		)
		expect(hierarchyPrefix([{ key: "flat", label: "Flat" }], 0)).toBe("")
	})

	test("renders hierarchy only while the filter is empty", async () => {
		const setup = await testRender(
			() => (
				<InteractiveSelectPrompt
					prompt="Work on"
					choices={[
						{ key: "epic", label: "epic delivery", depth: 0 },
						{ key: "child", label: "task delivery-child", depth: 1 },
						{ key: "standalone", label: "task standalone", depth: 0 },
					]}
					onDone={() => undefined}
				/>
			),
			{ width: 40, height: 4 },
		)
		try {
			await setup.renderer.setupTerminal()
			await setup.renderOnce()
			await Bun.sleep(0)

			let frame = setup.captureCharFrame()
			expect(frame).toContain("▌ ╭─ epic delivery")
			expect(frame).toContain("  │  ╰─ task delivery-child")

			setup.mockInput.pressArrow("down")
			await setup.flush()
			frame = setup.captureCharFrame()
			expect(frame).toContain("  ╭─ epic delivery")
			expect(frame).toContain("▌ │  ╰─ task delivery-child")

			await setup.mockInput.typeText("delivery")
			await setup.flush()
			frame = setup.captureCharFrame()
			expect(frame).toContain("▌ epic delivery")
			expect(frame).toContain("  task delivery-child")
			expect(frame).not.toMatch(/[╭│├╰─]/)

			setup.mockInput.pressKey("u", { ctrl: true })
			await setup.flush()
			setup.resize(32, 4)
			await setup.flush()
			frame = setup.captureCharFrame()
			expect(frame).toContain("▌ ╭─ epic delivery")
			expect(frame).toContain("  │  ╰─ task delivery-child")
		} finally {
			setup.renderer.destroy()
		}
	})

	test("keeps connectors stable while highlighting the full active row", async () => {
		const setup = await testRender(
			() => (
				<InteractiveSelectPrompt
					prompt="Work on"
					choices={[
						{ key: "agency", label: "agency", depth: 0 },
						{ key: "web", label: "web", depth: 0 },
					]}
					onDone={() => undefined}
				/>
			),
			{ width: 40, height: 4 },
		)
		try {
			await setup.renderer.setupTerminal()
			await setup.renderOnce()
			await Bun.sleep(0)

			let lines = setup.captureSpans().lines
			let active = lines.find((line) =>
				line.spans.some((span) => span.text === "▌ "),
			)!
			expect(
				active.spans.find((span) => span.text === "▌ ")?.fg.toInts(),
			).toEqual([198, 160, 246, 255])
			expect(
				active.spans.find((span) => span.text === "╭─ ")?.fg.toInts(),
			).toEqual([128, 135, 162, 255])
			expect(active.spans.map((span) => span.bg.toInts())).toEqual(
				Array.from({ length: active.spans.length }, () => [73, 77, 100, 255]),
			)

			setup.mockInput.pressArrow("down")
			await setup.flush()
			lines = setup.captureSpans().lines
			active = lines.find((line) =>
				line.spans.some((span) => span.text === "▌ "),
			)!
			expect(
				lines
					.flatMap((line) => line.spans)
					.find((span) => span.text === "╭─ ")
					?.fg.toInts(),
			).toEqual([128, 135, 162, 255])
			expect(
				active.spans.find((span) => span.text === "╰─ ")?.fg.toInts(),
			).toEqual([128, 135, 162, 255])
			expect(active.spans.map((span) => span.bg.toInts())).toEqual(
				Array.from({ length: active.spans.length }, () => [73, 77, 100, 255]),
			)
		} finally {
			setup.renderer.destroy()
		}
	})

	test("renders entity and status Nerd Font icons in distinct colors", async () => {
		const setup = await testRender(
			() => (
				<InteractiveSelectPrompt
					prompt="Work on"
					choices={[
						{
							key: "verify",
							label: "[done] phase verify",
							depth: 0,
							segments: [
								{ text: "󰄬", color: "#a6da95" },
								{ text: " " },
								{ text: "󰔚", color: "#eed49f" },
								{ text: " verify" },
							],
						},
					]}
					onDone={() => undefined}
				/>
			),
			{ width: 40, height: 4 },
		)
		try {
			await setup.renderer.setupTerminal()
			await setup.renderOnce()
			await Bun.sleep(0)

			expect(setup.captureCharFrame()).toContain("▌ ╰─ 󰄬 󰔚 verify")
			const spans = setup.captureSpans().lines.flatMap((line) => line.spans)
			expect(spans.find((span) => span.text === "󰄬")?.fg.toInts()).toEqual([
				166, 218, 149, 255,
			])
			expect(spans.find((span) => span.text === "󰔚")?.fg.toInts()).toEqual([
				238, 212, 159, 255,
			])
		} finally {
			setup.renderer.destroy()
		}
	})

	test("clears a non-empty filter before escape cancels", async () => {
		let selected: string | null | undefined
		const setup = await testRender(
			() => (
				<InteractiveSelectPrompt
					prompt="Work on"
					choices={[
						{ key: "agency", label: "agency", depth: 0 },
						{ key: "web", label: "web", depth: 0 },
					]}
					onDone={(value) => {
						selected = value
					}}
				/>
			),
			{ width: 40, height: 4, kittyKeyboard: true },
		)
		try {
			await setup.renderer.setupTerminal()
			await setup.renderOnce()
			await Bun.sleep(0)
			await setup.mockInput.typeText("web")
			await setup.flush()
			expect(setup.captureCharFrame()).toContain("▌ web")

			setup.mockInput.pressEscape()
			await setup.flush()
			expect(selected).toBeUndefined()
			const cleared = setup.captureCharFrame()
			expect(cleared).toContain("▌ ╭─ agency")
			expect(cleared).toContain("  ╰─ web")

			setup.mockInput.pressEscape()
			await setup.waitFor(() => selected !== undefined)
			expect(selected).toBeNull()
		} finally {
			setup.renderer.destroy()
		}
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

	test("uses printable j, k, q, and ? characters as the fuzzy query", async () => {
		for (const query of ["j", "k", "q", "?"]) {
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

	test("supports the readline movement and deletion contract", async () => {
		const cases = [
			{
				name: "left arrow",
				expected: "aXb",
				edit: async (input: MockInput) => {
					await input.typeText("ab")
					input.pressArrow("left")
					await input.typeText("X")
				},
			},
			{
				name: "home and end",
				expected: "XabY",
				edit: async (input: MockInput) => {
					await input.typeText("ab")
					input.pressKey(KeyCodes.HOME)
					await input.typeText("X")
					input.pressKey(KeyCodes.END)
					await input.typeText("Y")
				},
			},
			{
				name: "backspace and delete",
				expected: "a",
				edit: async (input: MockInput) => {
					await input.typeText("abc")
					input.pressBackspace()
					input.pressArrow("left")
					input.pressKey(KeyCodes.DELETE)
				},
			},
			{
				name: "ctrl-a and ctrl-e",
				expected: "XabY",
				edit: async (input: MockInput) => {
					await input.typeText("ab")
					input.pressKey("a", { ctrl: true })
					await input.typeText("X")
					input.pressKey("e", { ctrl: true })
					await input.typeText("Y")
				},
			},
			{
				name: "ctrl-b and ctrl-f",
				expected: "aXb",
				edit: async (input: MockInput) => {
					await input.typeText("ab")
					input.pressKey("b", { ctrl: true })
					input.pressKey("b", { ctrl: true })
					input.pressKey("f", { ctrl: true })
					await input.typeText("X")
				},
			},
			{
				name: "meta-b and meta-f",
				expected: "one Xtwo",
				edit: async (input: MockInput) => {
					await input.typeText("one two")
					input.pressKey("b", { meta: true })
					input.pressKey("b", { meta: true })
					input.pressKey("f", { meta: true })
					await input.typeText("X")
				},
			},
			{
				name: "ctrl-u",
				expected: "c",
				edit: async (input: MockInput) => {
					await input.typeText("abc")
					input.pressArrow("left")
					input.pressKey("u", { ctrl: true })
				},
			},
			{
				name: "ctrl-k",
				expected: "ab",
				edit: async (input: MockInput) => {
					await input.typeText("abc")
					input.pressArrow("left")
					input.pressKey("k", { ctrl: true })
				},
			},
			{
				name: "ctrl-w",
				expected: "one ",
				edit: async (input: MockInput) => {
					await input.typeText("one two")
					input.pressKey("w", { ctrl: true })
				},
			},
			{
				name: "ctrl-d",
				expected: "ab",
				edit: async (input: MockInput) => {
					await input.typeText("abc")
					input.pressArrow("left")
					input.pressKey("d", { ctrl: true })
				},
			},
			{
				name: "ctrl-h",
				expected: "ab",
				edit: async (input: MockInput) => {
					await input.typeText("abc")
					input.pressKey("h", { ctrl: true })
				},
			},
		]

		for (const contract of cases) {
			expect(await submitEditedText(contract.edit), contract.name).toBe(
				contract.expected,
			)
		}
	})

	test("yanks the most recently killed text in both prompt inputs", async () => {
		expect(
			await submitEditedText(async (input) => {
				await input.typeText("one two")
				input.pressKey("w", { ctrl: true })
				input.pressKey("y", { ctrl: true })
			}),
		).toBe("one two")

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
			await setup.mockInput.typeText("web")
			setup.mockInput.pressKey("u", { ctrl: true })
			setup.mockInput.pressKey("y", { ctrl: true })
			setup.mockInput.pressEnter()
			await setup.waitFor(() => selected !== undefined)
			expect(selected).toBe("web")
		} finally {
			setup.renderer.destroy()
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

	test("wraps text prompt input onto another line", async () => {
		const setup = await testRender(
			() => <InteractiveTextPrompt prompt="Task ID" onDone={() => {}} />,
			{ width: 16, height: 5 },
		)
		try {
			await setup.renderer.setupTerminal()
			await setup.renderOnce()
			await Bun.sleep(0)
			await setup.mockInput.typeText("alpha beta gamma delta")
			await setup.flush()
			const frame = setup.captureCharFrame()
			expect(frame).toContain("alpha beta")
			expect(frame).toContain("gamma")
			expect(frame).toMatch(/alpha beta\s*\ngamma delta/)
		} finally {
			setup.renderer.destroy()
		}
	})

	test("keeps empty and single-item list boundaries safe", async () => {
		let emptyResult: string | null | undefined
		const empty = await testRender(
			() => (
				<InteractiveSelectPrompt
					prompt="Empty"
					choices={[]}
					onDone={(value) => {
						emptyResult = value
					}}
				/>
			),
			{ width: 60, height: 4 },
		)
		try {
			await empty.renderer.setupTerminal()
			await empty.renderOnce()
			await Bun.sleep(0)
			empty.mockInput.pressArrow("up")
			empty.mockInput.pressArrow("down")
			empty.mockInput.pressKey("p", { ctrl: true })
			empty.mockInput.pressKey("n", { ctrl: true })
			empty.mockInput.pressEnter()
			await Bun.sleep(0)
			expect(emptyResult).toBeUndefined()
			expect(empty.captureCharFrame()).toContain("No matches")
		} finally {
			empty.renderer.destroy()
		}

		for (const move of ["up", "down"] as const) {
			let singleResult: string | null | undefined
			const single = await testRender(
				() => (
					<InteractiveSelectPrompt
						prompt="Single"
						choices={[{ key: "one", label: "One" }]}
						onDone={(value) => {
							singleResult = value
						}}
					/>
				),
				{ width: 60, height: 4 },
			)
			try {
				await single.renderer.setupTerminal()
				await single.renderOnce()
				await Bun.sleep(0)
				single.mockInput.pressArrow(move)
				single.mockInput.pressEnter()
				await single.waitFor(() => singleResult !== undefined)
				expect(singleResult).toBe("one")
			} finally {
				single.renderer.destroy()
			}
		}
	})

	test("remains usable after a narrow terminal resize", async () => {
		let selected: string | null | undefined
		const setup = await testRender(
			() => (
				<InteractiveSelectPrompt
					prompt="Repository with a long prompt"
					choices={[
						{ key: "agency", label: "agency" },
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
			setup.resize(18, 4)
			await setup.renderOnce()
			await setup.mockInput.typeText("docs")
			await setup.renderOnce()
			expect(setup.captureCharFrame()).toContain("> docs")
			setup.mockInput.pressEnter()
			await setup.waitFor(() => selected !== undefined)
			expect(selected).toBe("docs")
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
