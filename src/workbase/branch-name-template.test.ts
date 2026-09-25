import { describe, expect, test } from "bun:test"
import {
	expandBranchNameCommand,
	validateBranchNameCommand,
} from "./branch-name-template"

describe("branchNameCommand templates", () => {
	test("expands every supported placeholder with argv semantics", () => {
		expect(
			expandBranchNameCommand(
				[
					"resolve",
					"{id}|{ticket}|{ticketUrl}|{repo}|{base}|{workbaseRoot}|{taskId}|{phaseId}",
				],
				{
					id: "build",
					ticket: "CAN-123",
					ticketUrl: "https://example.com/CAN-123",
					repo: "app",
					base: "main",
					workbaseRoot: "/workbase",
					taskId: "ship",
					phaseId: "build",
				},
			),
		).toEqual([
			"resolve",
			"build|CAN-123|https://example.com/CAN-123|app|main|/workbase|ship|build",
		])
	})

	test("rejects unknown placeholders", () => {
		expect(() => validateBranchNameCommand(["resolve", "{unknown}"])).toThrow(
			"Unknown branchNameCommand placeholder: {unknown}",
		)
	})
})
