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
			"\x1b[38;2;187;154;247m\x1b[0m delivery\x1b[2m - Ship the release\x1b[0m",
			"\x1b[38;2;125;207;255m󰗡\x1b[0m multi",
			"\x1b[38;2;122;162;247m󰔟\x1b[0m \x1b[38;2;224;175;104m󰔚\x1b[0m build",
			"\x1b[38;2;158;206;106m󰄬\x1b[0m \x1b[38;2;224;175;104m󰔚\x1b[0m verify",
			"\x1b[38;2;247;118;142m󰅖\x1b[0m \x1b[38;2;224;175;104m󰔚\x1b[0m unlisted",
			"\x1b[38;2;158;206;106m󰄬\x1b[0m \x1b[38;2;125;207;255m󰗡\x1b[0m single",
			"\x1b[38;2;108;112;134m󰄱\x1b[0m \x1b[38;2;125;207;255m󰗡\x1b[0m standalone\x1b[2m - Independent work\x1b[0m",
			"\x1b[38;2;187;154;247m󰁕\x1b[0m \x1b[38;2;125;207;255m󰗡\x1b[0m delegated",
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
			{ text: "", color: "#bb9af7" },
			{ text: " delivery" },
			{ text: " - Ship the release", color: "#6c7086" },
		])
		expect(choices[2]!.segments).toEqual([
			{ text: "󰔟", color: "#7aa2f7" },
			{ text: " " },
			{ text: "󰔚", color: "#e0af68" },
			{ text: " build" },
		])
	})
})
