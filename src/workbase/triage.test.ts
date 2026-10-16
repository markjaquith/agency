import { describe, expect, test } from "bun:test"
import { TRIAGE_AGENT, triageAgentConfig } from "./triage-contract"
import { boundTranscript, retryMessage, validateResponse } from "./triage"

const assessment = (key: string) => ({
	key,
	status: "in_progress",
	summary: "Going",
	question: null,
	actions: [],
})

describe("validateResponse", () => {
	test("accepts one assessment per requested key, even inside fences", () => {
		const result = validateResponse(
			`Here you go:\n\`\`\`json\n${JSON.stringify({
				version: 1,
				items: [assessment("a"), assessment("b")],
			})}\n\`\`\``,
			["a", "b"],
		)
		expect(result.ok).toBe(true)
		if (result.ok) expect([...result.items.keys()]).toEqual(["a", "b"])
	})

	test("reports missing, unknown, and repeated keys", () => {
		const result = validateResponse(
			JSON.stringify({
				version: 1,
				items: [assessment("a"), assessment("a"), assessment("z")],
			}),
			["a", "b"],
		)
		expect(result).toEqual({
			ok: false,
			errors: [
				'Item key "a" appears twice.',
				'Unknown item key "z".',
				'Missing item key "b".',
			],
		})
	})

	test("rejects replies outside the locked contract", () => {
		const extra = validateResponse(
			JSON.stringify({
				version: 1,
				items: [{ ...assessment("a"), priority: "high" }],
			}),
			["a"],
		)
		expect(extra.ok).toBe(false)
		const action = validateResponse(
			JSON.stringify({
				version: 1,
				items: [{ ...assessment("a"), actions: [{ type: "agency" }] }],
			}),
			["a"],
		)
		expect(action.ok).toBe(false)
		expect(validateResponse("no json here", ["a"])).toEqual({
			ok: false,
			errors: ["The reply has no JSON object."],
		})
	})

	test("rejects repeated action ids within an item", () => {
		const action = {
			version: 1,
			id: "x",
			type: "open_url",
			title: "Open",
			rationale: "Look",
			risk: "read-only",
			subject: {
				workbase: null,
				item: null,
				runtime: [],
				pullRequest: null,
				ticket: null,
			},
			preconditions: [],
			payload: { url: "https://example.com" },
		}
		const result = validateResponse(
			JSON.stringify({
				version: 1,
				items: [{ ...assessment("a"), actions: [action, action] }],
			}),
			["a"],
		)
		expect(result).toEqual({
			ok: false,
			errors: ['Item "a" repeats action id "x".'],
		})
	})
})

test("boundTranscript keeps the trimmed tail", () => {
	const text = `${Array.from({ length: 300 }, (_, index) => `line ${index}`).join("\n")}\n\n  \n`
	const tail = boundTranscript(text)
	expect(tail.split("\n")).toHaveLength(120)
	expect(tail.endsWith("line 299")).toBe(true)
	expect(boundTranscript("x".repeat(10_000))).toHaveLength(6000)
})

test("retryMessage lists every validation error", () => {
	expect(retryMessage(["one", "two"])).toBe(
		"Your reply did not satisfy the triage contract:\n- one\n- two\nReply again with the complete corrected JSON object only.",
	)
})

test("the managed triage agent denies everything but read-only tools", () => {
	const agent = JSON.parse(triageAgentConfig()).agents[TRIAGE_AGENT]
	const rules: { action: string; resource: string; effect: string }[] =
		agent.permissions
	expect(rules[0]).toEqual({ action: "*", resource: "*", effect: "deny" })
	const allowed = rules.filter((rule) => rule.effect === "allow")
	expect(allowed.map((rule) => rule.action)).not.toContain("edit")
	expect(
		allowed
			.filter((rule) => rule.action === "shell")
			.every((rule) =>
				/^(gh (pr|issue|run) (view|checks|diff|list)|acli jira workitem (view|search)|herdr pane (read|list)|agency (context|graph|attention|status)) \*$/.test(
					rule.resource,
				),
			),
	).toBe(true)
	expect(agent.system).toContain("contract version 1")
})
