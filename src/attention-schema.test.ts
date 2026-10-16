import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import actionSchema from "../schemas/agency-action-v1.schema.json"
import attentionSchema from "../schemas/agency-attention-v1.schema.json"
import { attentionValidators } from "./test-utils"
import {
	ActionPrecondition,
	AttentionSignalKind,
	SupervisorAction,
} from "./attention-schema"

const subject = {
	workbase: { id: "wb-1", name: "main", root: "/work" },
	item: {
		unit: "execution-unit:task/alpha",
		kind: "task",
		taskId: "alpha",
		path: "/work/tasks/alpha/TASK.md",
		archived: false,
	},
	runtime: [],
	pullRequest: null,
	ticket: null,
}

const action = (type: string, payload: unknown) => ({
	version: 1,
	id: `signal/${type}`,
	type,
	title: type,
	rationale: "Because",
	risk: "reversible",
	subject,
	preconditions: [
		{
			kind: "pane_matches",
			runtime: "herdr",
			paneId: "w1:p1",
			tabId: "w1:t1",
			cwd: "/work/tasks/alpha",
			agentSessionId: null,
			agentStatuses: ["idle"],
		},
		{
			kind: "tab_agent_panes",
			runtime: "herdr",
			tabId: "w1:t1",
			paneIds: ["w1:p1"],
		},
		{ kind: "pull_request_head", url: "https://x/pull/1", sha: "abc" },
	],
	payload,
})

const agencyPayload = {
	actionId: "task-create",
	selector: { task: "alpha" },
	inputs: [{ id: "id", label: "Task ID", required: true }],
	values: { id: "adopted" },
	cwd: "/work",
	bindRuntime: null,
}

const samples = [
	action("agency", {
		...agencyPayload,
		command: null,
		commandTemplate: ["agency", "task", "create", "<id>"],
	}),
	action("runtime", {
		runtime: "herdr",
		operation: "close",
		target: "tab",
		id: "w1:t1",
	}),
	action("command", { argv: ["gh", "pr", "merge"], cwd: null }),
	action("prompt_agent", {
		runtime: "herdr",
		paneId: "w1:p1",
		agentSessionId: null,
		prompt: "Continue",
	}),
	action("delegate", {
		unit: "execution-unit:task/alpha",
		instructions: "Finish it",
		via: "kickoff",
	}),
	action("open_url", { url: "https://example.com" }),
]

describe("attention contracts", () => {
	test("publishes the action schema as one variant per type", () => {
		expect(actionSchema).toMatchObject({
			$schema: "https://json-schema.org/draft/2020-12/schema",
			$id: "https://github.com/markjaquith/agency/schemas/agency-action-v1.schema.json",
			title: "Agency supervisor action v1",
		})
		expect(
			actionSchema.oneOf.map((variant) => variant.properties.type.const),
		).toEqual(
			SupervisorAction.members.map((member) => member.fields.type.literal),
		)
		expect(
			actionSchema.$defs.precondition.oneOf.map(
				(variant) => variant.properties.kind.const,
			),
		).toEqual(
			ActionPrecondition.members.map((member) => member.fields.kind.literal),
		)
		expect(attentionSchema.$defs.signalKind.enum).toEqual([
			...AttentionSignalKind.literals,
		])
	})

	test("JSON Schema and Effect Schema agree on every action type", () => {
		const { action: validate } = attentionValidators()
		for (const sample of samples) {
			expect(validate(sample)).toBe(true)
			expect(() =>
				Schema.decodeUnknownSync(SupervisorAction, {
					onExcessProperty: "error",
				})(sample),
			).not.toThrow()
		}
	})

	test("an agency action has exactly one of command and commandTemplate", () => {
		const { action: validate } = attentionValidators()
		for (const argv of [
			{ command: ["agency", "sync"], commandTemplate: ["agency", "<x>"] },
			{ command: null, commandTemplate: null },
		]) {
			const sample = action("agency", { ...agencyPayload, ...argv })
			expect(validate(sample)).toBe(false)
			expect(() => Schema.decodeUnknownSync(SupervisorAction)(sample)).toThrow()
		}
	})

	test("rejects a payload that belongs to another type", () => {
		const { action: validate } = attentionValidators()
		expect(validate(action("runtime", { url: "https://example.com" }))).toBe(
			false,
		)
	})
})
