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
			"\x1b[35m\x1b[0m delivery\x1b[2m - Ship the release\x1b[0m",
			"  \x1b[36m󰗡\x1b[0m multi",
			"    \x1b[34m◐\x1b[0m \x1b[33m󰔚\x1b[0m build",
			"    \x1b[32m✓\x1b[0m \x1b[33m󰔚\x1b[0m verify",
			"    \x1b[31m⊘\x1b[0m \x1b[33m󰔚\x1b[0m unlisted",
			"  \x1b[32m✓\x1b[0m \x1b[36m󰗡\x1b[0m single",
			"\x1b[2m○\x1b[0m \x1b[36m󰗡\x1b[0m standalone\x1b[2m - Independent work\x1b[0m",
			"\x1b[35m↗\x1b[0m \x1b[36m󰗡\x1b[0m delegated",
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
	})
})
