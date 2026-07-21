import { describe, expect, test } from "bun:test"
import { buildWorkTargetChoices } from "./work-target"

describe("work target choices", () => {
	test("builds an ordered hierarchy with standalone tasks", () => {
		const choices = buildWorkTargetChoices(
			[
				{
					id: "delivery",
					path: "/workbase/epics/delivery/EPIC.md",
					data: {
						description: "Ship the release",
						tasks: [{ id: "multi" }, { id: "single" }],
					},
				},
			],
			[
				{
					id: "multi",
					path: "/workbase/tasks/multi/TASK.md",
					data: {
						phases: [{ id: "build" }, { id: "verify" }],
					},
				},
				{
					id: "single",
					path: "/workbase/tasks/single/TASK.md",
					data: { status: "done" },
				},
				{
					id: "standalone",
					path: "/workbase/tasks/standalone/TASK.md",
					data: { description: "Independent work" },
				},
				{
					id: "delegated",
					path: "/workbase/tasks/delegated/TASK.md",
					data: { status: "delegated" },
				},
			],
			[
				{
					taskId: "multi",
					id: "verify",
					path: "/workbase/tasks/multi/phases/verify/PHASE.md",
					data: { status: "done" },
				},
				{
					taskId: "multi",
					id: "build",
					path: "/workbase/tasks/multi/phases/build/PHASE.md",
					data: { status: "working" },
				},
				{
					taskId: "multi",
					id: "unlisted",
					path: "/workbase/tasks/multi/phases/unlisted/PHASE.md",
					data: { status: "dropped" },
				},
			],
		)

		expect(choices.map((choice) => choice.label)).toEqual([
			"\x1b[38;2;198;160;246m\x1b[0m delivery\x1b[2m - Ship the release\x1b[0m",
			"\x1b[38;2;125;196;228m󰗡\x1b[0m multi",
			"\x1b[38;2;138;173;244m󰔟\x1b[0m \x1b[38;2;238;212;159m󰔚\x1b[0m build",
			"\x1b[38;2;166;218;149m󰄬\x1b[0m \x1b[38;2;238;212;159m󰔚\x1b[0m verify",
			"\x1b[38;2;237;135;150m󰅖\x1b[0m \x1b[38;2;238;212;159m󰔚\x1b[0m unlisted",
			"\x1b[38;2;166;218;149m󰄬\x1b[0m \x1b[38;2;125;196;228m󰗡\x1b[0m single",
			"\x1b[38;2;128;135;162m󰄱\x1b[0m \x1b[38;2;125;196;228m󰗡\x1b[0m standalone\x1b[2m - Independent work\x1b[0m",
			"\x1b[38;2;198;160;246m󰁕\x1b[0m \x1b[38;2;125;196;228m󰗡\x1b[0m delegated",
		])
		expect(choices.map((choice) => choice.target.kind)).toEqual([
			"epic",
			"task",
			"phase",
			"phase",
			"phase",
			"task",
			"task",
			"task",
		])
		expect(choices.map((choice) => choice.plainLabel)).toEqual([
			"epic delivery - Ship the release",
			"task multi",
			"[working] phase build",
			"[done] phase verify",
			"[dropped] phase unlisted",
			"[done] task single",
			"[open] task standalone - Independent work",
			"[delegated] task delegated",
		])
		expect(choices.map((choice) => choice.depth)).toEqual([
			0, 1, 2, 2, 2, 1, 0, 0,
		])
		expect(choices[0]!.segments).toEqual([
			{ text: "", color: "#c6a0f6" },
			{ text: " delivery" },
			{ text: " - Ship the release", color: "#6e738d" },
		])
		expect(choices[2]!.segments).toEqual([
			{ text: "󰔟", color: "#8aadf4" },
			{ text: " " },
			{ text: "󰔚", color: "#eed49f" },
			{ text: " build" },
		])
	})
})
