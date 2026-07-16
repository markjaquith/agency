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
					data: {},
				},
				{
					id: "standalone",
					path: "/workbase/tasks/standalone/TASK.md",
					data: { description: "Independent work" },
				},
			],
			[
				{
					taskId: "multi",
					id: "verify",
					path: "/workbase/tasks/multi/phases/verify/PHASE.md",
					data: {},
				},
				{
					taskId: "multi",
					id: "build",
					path: "/workbase/tasks/multi/phases/build/PHASE.md",
					data: {},
				},
				{
					taskId: "multi",
					id: "unlisted",
					path: "/workbase/tasks/multi/phases/unlisted/PHASE.md",
					data: {},
				},
			],
		)

		expect(choices.map((choice) => choice.label)).toEqual([
			"epic  delivery - Ship the release",
			"  task  multi",
			"    phase  build",
			"    phase  verify",
			"    phase  unlisted",
			"  task  single",
			"task  standalone - Independent work",
		])
		expect(choices.map((choice) => choice.target.kind)).toEqual([
			"epic",
			"task",
			"phase",
			"phase",
			"phase",
			"task",
			"task",
		])
	})
})
