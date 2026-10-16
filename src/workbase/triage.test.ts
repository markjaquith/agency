import { describe, expect, test } from "bun:test"
import type {
	AttentionSignal,
	AttentionSubject,
	SupervisorAction,
} from "../attention-schema"
import type {
	AttentionUnit,
	AttentionWorkbase,
	CatalogAction,
} from "./attention"
import { TRIAGE_AGENT, triageAgentConfig } from "./triage-contract"
import {
	boundTranscript,
	chunk,
	retryMessage,
	validateResponse,
	type TriageItem,
} from "./triage"
import { runtimePane } from "../test-utils"

const root = "/work"
const subject: AttentionSubject = {
	workbase: { id: "wb", name: "main", root },
	item: {
		unit: "execution-unit:task/alpha",
		kind: "task",
		taskId: "alpha",
		path: "/work/tasks/alpha/TASK.md",
		archived: false,
	},
	runtime: [
		{
			runtime: "herdr",
			paneId: "w1:p1",
			tabId: "w1:t1",
			workspaceId: "w1",
			agent: "opencode",
			agentSessionId: "ses_1",
		},
	],
	pullRequest: null,
	ticket: null,
}

const paneMatches = (paneId = "w1:p1", tabId = "w1:t1") => ({
	kind: "pane_matches" as const,
	runtime: "herdr" as const,
	paneId,
	tabId,
	cwd: "/work/tasks/alpha",
	agentSessionId: "ses_1",
	agentStatuses: ["idle" as const],
})

const focus: SupervisorAction = {
	version: 1,
	id: "agent_waiting:/work:execution-unit:task/alpha:w1:p1/focus-pane-w1:p1",
	type: "runtime",
	title: "Focus pane w1:p1",
	rationale: "Look",
	risk: "reversible",
	subject: { ...subject, runtime: [] },
	preconditions: [paneMatches()],
	payload: {
		runtime: "herdr",
		operation: "focus",
		target: "pane",
		id: "w1:p1",
	},
}

const sync: CatalogAction = {
	id: "sync",
	label: "Sync",
	available: true,
	blockedReason: null,
	command: ["agency", "sync", "alpha", "--json"],
	commandTemplate: null,
	inputs: [],
}

const status: CatalogAction = {
	id: "done",
	label: "Done",
	available: true,
	blockedReason: null,
	command: null,
	commandTemplate: [
		"agency",
		"task",
		"status",
		"alpha",
		"done",
		"--summary",
		"{summary}",
	],
	inputs: [{ id: "summary", label: "Summary", required: true }],
}

const item = (key: string): TriageItem => ({
	key,
	workbase: {
		ref: subject.workbase,
		roots: [root],
	} as unknown as AttentionWorkbase,
	unit: { item: subject.item } as AttentionUnit,
	panes: [
		{
			...runtimePane({ paneId: "w1:p1", agentSessionId: "ses_1" }),
			binding: "recorded",
		},
	],
	signals: [{ actions: [focus] } as unknown as AttentionSignal],
	subject,
	agencyActions: [sync, status],
})

const assessment = (key: string, actions: unknown[] = []) => ({
	key,
	status: "in_progress",
	summary: "Going",
	question: null,
	actions,
})

const reply = (...items: unknown[]) => JSON.stringify({ version: 1, items })

const model = (
	type: string,
	payload: unknown,
	fields: Record<string, unknown> = {},
) => ({
	version: 1,
	id: `triage:a:${type}`,
	type,
	title: type,
	rationale: "Because",
	risk: "reversible",
	subject: {
		workbase: null,
		item: null,
		runtime: [],
		pullRequest: null,
		ticket: null,
	},
	preconditions: [paneMatches()],
	payload,
	...fields,
})

const agencyPayload = (overrides: Record<string, unknown> = {}) => ({
	actionId: "done",
	selector: { task: "alpha" },
	inputs: status.inputs,
	values: { summary: "Shipped" },
	cwd: root,
	bindRuntime: null,
	command: null,
	commandTemplate: status.commandTemplate,
	...overrides,
})

const errorsOf = (text: string, items = [item("a")]) => {
	const result = validateResponse(text, items)
	return result.ok ? [] : result.errors
}

describe("validateResponse", () => {
	test("accepts one assessment per requested key, even inside fences", () => {
		const result = validateResponse(
			`Here you go:\n\`\`\`json\n${reply(assessment("a"), assessment("b"))}\n\`\`\``,
			[item("a"), item("b")],
		)
		expect(result.ok).toBe(true)
		if (result.ok) expect([...result.items.keys()]).toEqual(["a", "b"])
	})

	test("reports missing, unknown, and repeated keys", () => {
		expect(
			errorsOf(reply(assessment("a"), assessment("a"), assessment("z")), [
				item("a"),
				item("b"),
			]),
		).toEqual([
			'Item key "a" appears twice.',
			'Unknown item key "z".',
			'Missing item key "b".',
		])
	})

	test("rejects replies outside the locked contract", () => {
		expect(
			errorsOf(reply({ ...assessment("a"), priority: "high" })),
		).not.toEqual([])
		expect(errorsOf(reply(assessment("a", [{ type: "agency" }])))).not.toEqual(
			[],
		)
		expect(errorsOf("no json here")).toEqual(["The reply has no JSON object."])
	})

	test("trusts verbatim signal actions and gives every action the item's subject", () => {
		const result = validateResponse(
			reply(
				assessment("a", [{ ...focus, subject: { ...subject, item: null } }]),
			),
			[item("a")],
		)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		const accepted = result.items.get("a")!
		expect(accepted.modelActionIds).toEqual([])
		expect(accepted.actions[0]!.subject).toEqual(subject)
	})

	test("marks and checks model-written actions", () => {
		const agency = model("agency", agencyPayload())
		const result = validateResponse(reply(assessment("a", [agency])), [
			item("a"),
		])
		expect(result.ok).toBe(true)
		if (result.ok)
			expect(result.items.get("a")!.modelActionIds).toEqual(["triage:a:agency"])
	})

	test("rejects agency actions that differ from the discovered argv", () => {
		const errors = errorsOf(
			reply(
				assessment("a", [
					model(
						"agency",
						agencyPayload({
							command: [
								"agency",
								"task",
								"status",
								"alpha",
								"done",
								"--summary",
								"x",
							],
							commandTemplate: null,
						}),
					),
					model("agency", agencyPayload({ actionId: "drop" }), {
						id: "triage:a:drop",
					}),
					model("agency", agencyPayload({ cwd: "/elsewhere" }), {
						id: "triage:a:cwd",
					}),
				]),
			),
		)
		expect(errors).toEqual([
			expect.stringContaining("must copy command and commandTemplate exactly"),
			expect.stringContaining('uses agency action "drop"'),
			expect.stringContaining("must run from the item's workbase root"),
		])
	})

	test("rejects foreign panes, missing pane checks, and read-only model commands", () => {
		const errors = errorsOf(
			reply(
				assessment("a", [
					model("runtime", {
						runtime: "herdr",
						operation: "close",
						target: "pane",
						id: "w9:p9",
					}),
					model(
						"prompt_agent",
						{
							runtime: "herdr",
							paneId: "w1:p1",
							agentSessionId: "ses_1",
							prompt: "Yes, rebase.",
						},
						{ preconditions: [] },
					),
					model(
						"command",
						{ argv: ["rm", "-rf", "/"], cwd: null },
						{ risk: "read-only" },
					),
					model("open_url", { url: "https://x" }, { risk: "read-only" }),
					model(
						"delegate",
						{
							unit: "execution-unit:task/alpha",
							instructions: "Go",
							via: "prompt_bound_agent",
						},
						{ id: "triage:a:read-only-delegate", risk: "read-only" },
					),
					model("delegate", {
						unit: "execution-unit:task/other",
						instructions: "Go",
						via: "kickoff",
					}),
					{ ...focus, id: "agent_waiting:forged", title: "Changed" },
				]),
			),
		)
		expect(errors).toEqual([
			expect.stringContaining("targets pane w9:p9, which is not the item's"),
			expect.stringContaining("needs a pane_matches precondition for w9:p9"),
			expect.stringContaining("needs a pane_matches precondition for w1:p1"),
			expect.stringContaining("its risk cannot be read-only"),
			expect.stringContaining("its risk cannot be read-only"),
			expect.stringContaining("its risk cannot be read-only"),
			expect.stringContaining("delegates a unit that is not the item's"),
			expect.stringContaining('id must start with "triage:"'),
		])
	})

	test("rejects repeated action ids within an item", () => {
		expect(errorsOf(reply(assessment("a", [focus, focus])))).toEqual([
			`Item "a" repeats action id "${focus.id}".`,
		])
	})
})

test("chunk splits batches without reordering", () => {
	expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
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

/**
 * Evaluate rules the way OpenCode does: whole-value wildcards (`*` matches
 * anything, `?` one character) and the last matching rule wins; no match asks.
 */
const permissionEffect = (
	rules: readonly { action: string; resource: string; effect: string }[],
	action: string,
	resource: string,
) => {
	const matches = (pattern: string, value: string) =>
		new RegExp(
			`^${pattern
				.split("")
				.map((char) =>
					char === "*"
						? "[\\s\\S]*"
						: char === "?"
							? "[\\s\\S]"
							: char.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"),
				)
				.join("")}$`,
		).test(value)
	let effect: string = "ask"
	for (const rule of rules)
		if (matches(rule.action, action) && matches(rule.resource, resource))
			effect = rule.effect
	return effect
}

describe("triage agent permissions", () => {
	const rules = JSON.parse(
		triageAgentConfig({ readRoots: [root], settings: {} }),
	).agents[TRIAGE_AGENT].permissions
	const effect = (action: string, resource: string) =>
		permissionEffect(rules, action, resource)

	test("allow read-only commands on GitHub and Agency", () => {
		for (const command of [
			"gh pr view https://github.com/acme/agency/pull/7",
			"gh pr checks https://github.com/acme/agency/pull/7",
			"gh pr diff https://github.com/acme/agency/pull/7",
			"gh issue view https://github.com/acme/agency/issues/3",
			"acli jira workitem view CAN-1",
			"herdr pane read w1:p1",
			"agency context /work/tasks/alpha --json",
		])
			expect([command, effect("shell", command)]).toEqual([command, "allow"])
	})

	test("deny redirection, browsers, other hosts, and mutations", () => {
		for (const command of [
			"gh pr view 1 > x",
			"gh pr view 1 >> x",
			"gh pr diff 1 2>x",
			"gh pr view https://github.com/a/b/pull/1 > ~/.zshrc",
			"gh pr view https://github.com/a/b/pull/1 >> ~/.zshrc",
			"gh pr diff https://github.com/a/b/pull/1 2>x",
			"gh pr view https://github.com/a/b/pull/1 < /etc/passwd",
			"gh pr view https://github.com/a/b/pull/1 --web",
			"gh pr view https://github.com/a/b/pull/1 -w",
			"gh pr checks https://github.com/a/b/pull/1 --watch",
			"gh pr view https://github.com/a/b/pull/1 -R evil.host/x/y",
			"gh pr view https://github.com/a/b/pull/1 --repo evil.host/x/y",
			"gh pr view https://github.com/a/b/pull/1 https://evil.host/data",
			"gh pr view https://github.com.evil.host/a/b/pull/1",
			"gh pr view 1",
			"gh pr list --search secret",
			"gh pr merge https://github.com/a/b/pull/1",
			"acli jira workitem view CAN-1 --web",
			"acli jira workitem transition --key CAN-1 --status Done",
			"agency task status alpha done",
			"rm -rf /",
		])
			expect([command, effect("shell", command)]).toEqual([command, "deny"])
	})

	test("allow reads only in the run directory and the workbase", () => {
		expect(effect("read", "snapshot.json")).toBe("allow")
		expect(effect("read", "/work/tasks/alpha/TASK.md")).toBe("allow")
		expect(effect("external_directory", "/work/tasks/alpha/*")).toBe("allow")
		expect(effect("read", "/work/.env")).toBe("deny")
		for (const path of [
			"/Users/me/.ssh/id_ed25519",
			"/Users/me/.local/share/opencode/auth.json",
			"/Users/me/.npmrc",
			"/workbase-other/x",
		])
			expect([path, effect("read", path)]).toEqual([path, "deny"])
		expect(effect("external_directory", "/Users/me/.ssh/*")).toBe("deny")
		for (const action of ["edit", "glob", "grep", "webfetch", "skill"])
			expect(effect(action, "anything")).toBe("deny")
	})

	test("the agent config carries settings and the locked contract", () => {
		const config = JSON.parse(
			triageAgentConfig({
				readRoots: [root],
				settings: { model: "anthropic/claude" },
			}),
		)
		expect(config.model).toBe("anthropic/claude")
		const agent = config.agents[TRIAGE_AGENT]
		expect(agent.permissions).toEqual(rules)
		expect(agent.system).toContain("contract version 1")
	})
})
