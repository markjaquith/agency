import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdir, realpath } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { ActionPrecondition, SupervisorAction } from "../attention-schema"
import {
	cleanupTempDir,
	createFakeRuntimeProvider,
	createTempDir,
	fakeRuntimeService,
	runTestEffect,
	runtimePane,
} from "../test-utils"
import { documentRevision } from "../workbase/document-revision"
import type { RuntimePane } from "../workbase/runtime"
import {
	PullRequestStatusService,
	type LivePullRequest,
} from "./PullRequestStatusService"
import { RuntimeBindingService } from "./RuntimeBindingService"
import { RuntimeService } from "./RuntimeService"
import { SupervisionStateService } from "./SupervisionStateService"
import { TicketService } from "./TicketService"
import { SupervisorExecutor } from "./SupervisorExecutor"

let tempDir: string
let root: string
let env: NodeJS.ProcessEnv
let agencyCommand: string[]
let calls: unknown[][]
let panes: RuntimePane[]
let failures: Record<string, string>
let prReads: { url: string; fresh: boolean }[]
let ticketReads: { url: string | null; fresh: boolean }[]

const task = (status: string) => `---
repo: agency
branch: feat/alpha
base: main
pr: null
status: ${status}
---

# alpha
`

const write = async (path: string, content: string) => {
	await mkdir(dirname(path), { recursive: true })
	await Bun.write(path, content)
}

const discovery = (action: Record<string, unknown>) =>
	JSON.stringify({
		version: 1,
		ok: true,
		result: {
			creationDefaults: {
				branch: { configured: false, task: "task/<id>", phase: "x" },
			},
			workbase: { root, repositories: ["agency"], actions: [action] },
			currentWork: [],
			targets: [
				{
					kind: "task",
					id: "task:alpha",
					key: "alpha",
					status: "working",
					repositories: ["agency"],
					readiness: {
						ready: false,
						blocked: false,
						blockedBy: [],
						terminal: false,
						blockers: [],
					},
					revision: "abc",
					actions: [action],
					blockedActions: [],
				},
			],
		},
	})

/** A fake Agency CLI: `act` prints discovery; anything else is recorded. */
const fakeAgency = async (action: Record<string, unknown>) => {
	const script = join(tempDir, "fake-agency.sh")
	await write(join(tempDir, "discovery.json"), discovery(action))
	await write(
		script,
		`#!/bin/sh
if [ "$1" = act ]; then cat "${join(tempDir, "discovery.json")}"; exit 0; fi
echo "$@" >> "${join(tempDir, "ran.log")}"
echo "ran $1"
`,
	)
	agencyCommand = ["sh", script]
}

const subject = (unit = "alpha") => ({
	workbase: { id: null, name: null, root },
	item: {
		unit: `execution-unit:task/${unit}`,
		kind: "task" as const,
		taskId: unit,
		path: join(root, "tasks", unit, "TASK.md"),
		archived: false,
	},
	runtime: [],
	pullRequest: null,
	ticket: null,
})

const base = () => ({
	version: 1 as const,
	id: "signal/action",
	title: "Act",
	rationale: "Because.",
	risk: "reversible" as const,
	subject: subject(),
	preconditions: [] as ActionPrecondition[],
})

const agencyAction = (
	actionId: string,
	extra: Partial<Extract<SupervisorAction, { type: "agency" }>["payload"]> = {},
): SupervisorAction => ({
	...base(),
	type: "agency",
	payload: {
		actionId,
		selector: { task: "alpha" },
		inputs: [],
		values: {},
		cwd: root,
		bindRuntime: null,
		command: ["agency", "stale"],
		commandTemplate: null,
		...extra,
	} as Extract<SupervisorAction, { type: "agency" }>["payload"],
})

const livePr: LivePullRequest = {
	state: "available",
	url: "https://github.com/acme/agency/pull/1",
	prState: "open",
	draft: false,
	review: "approved",
	checks: "passing",
	mergeable: "mergeable",
	mergeState: "CLEAN",
	headSha: "new",
}

const run = <A, E>(
	use: (executor: SupervisorExecutor["Service"]) => Effect.Effect<A, E, any>,
) =>
	runTestEffect(
		Effect.flatMap(SupervisorExecutor, use).pipe(
			Effect.provideService(
				RuntimeService,
				fakeRuntimeService(
					createFakeRuntimeProvider({
						calls,
						failures,
						location: {
							runtime: "herdr",
							paneId: "w1:p0",
							tabId: "w1:t0",
							workspaceId: "w1",
						},
						snapshot: () => ({
							runtime: "herdr",
							workspaces: [],
							tabs: [],
							panes,
						}),
					}),
				),
			),
			Effect.provideService(PullRequestStatusService, {
				read: (url, readOptions) => {
					prReads.push({ url, fresh: readOptions?.fresh === true })
					return Effect.succeed(livePr)
				},
				mergeMethod: () => Effect.succeed("squash"),
			}),
			Effect.provideService(TicketService, {
				read: (url: string | null, readOptions?: { fresh?: boolean }) => {
					ticketReads.push({ url, fresh: readOptions?.fresh === true })
					return Effect.succeed({
						url: url!,
						state: "available" as const,
						provider: "jira",
						key: "CAN-1",
						status: "In Progress",
						statusCategory: "in_progress" as const,
						summary: "Ticket",
						resolution: null,
					})
				},
			} as unknown as TicketService["Service"]),
		),
	)

const confirmAndExecute = (
	executor: SupervisorExecutor["Service"],
	plan: Parameters<SupervisorExecutor["Service"]["confirm"]>[0],
	key: string | null,
) =>
	Effect.flatMap(
		executor.confirm(
			plan,
			{ confirmed: true, destructiveConfirmed: true },
			key,
			options(),
		),
		(token) => executor.execute(token, key, options()),
	)

/** Resolve, confirm (twice when destructive), and execute. */
const runAction = (
	executor: SupervisorExecutor["Service"],
	action: unknown,
	values: Record<string, string> = {},
	key: string | null = null,
) =>
	Effect.gen(function* () {
		const resolution = yield* executor.resolve(action, values, options())
		if (resolution.kind !== "ready") throw new Error(resolution.kind)
		const token = yield* executor.confirm(
			resolution.plan,
			{ confirmed: true, destructiveConfirmed: true },
			key,
			options(),
		)
		return yield* executor.execute(token, key, options())
	})

const options = () => ({ agencyCommand, env })

const actionLog = () =>
	runTestEffect(
		Effect.flatMap(SupervisionStateService, (state) => state.actions({}, env)),
	)

beforeEach(async () => {
	tempDir = await realpath(await createTempDir())
	root = join(tempDir, "workbase")
	env = { ...process.env, AGENCY_STATE_DIR: join(tempDir, "state") }
	calls = []
	panes = []
	failures = {}
	prReads = []
	ticketReads = []
	agencyCommand = ["false"]
	await write(join(root, "agency.json"), '{"version":2}\n')
	await write(join(root, "tasks/alpha/TASK.md"), task("working"))
	await write(join(root, "archive/tasks/old/TASK.md"), task("done"))
})

afterEach(() => cleanupTempDir(tempDir))

describe("SupervisorExecutor preconditions", () => {
	test("pass against unchanged state", async () => {
		const path = join(root, "tasks/alpha/TASK.md")
		panes = [
			runtimePane({
				paneId: "w1:p1",
				tabId: "w1:t1",
				cwd: "/x",
				agentSessionId: "ses",
			}),
			runtimePane({ paneId: "w1:p2", tabId: "w1:t1", agent: null }),
		]
		const failures = await run((executor) =>
			executor.checkPreconditions(
				{
					...base(),
					type: "open_url",
					payload: { url: "https://example.com" },
					preconditions: [
						{
							kind: "document_revision",
							path,
							sha256: documentRevision(task("working")),
						},
						{
							kind: "item_status",
							unit: "execution-unit:task/alpha",
							statuses: ["working"],
						},
						{
							kind: "item_archived",
							unit: "execution-unit:task/old",
							archived: true,
						},
						{
							kind: "pane_matches",
							runtime: "herdr",
							paneId: "w1:p1",
							tabId: "w1:t1",
							cwd: "/x",
							agentSessionId: "ses",
							agentStatuses: ["idle"],
						},
						{
							kind: "tab_agent_panes",
							runtime: "herdr",
							tabId: "w1:t1",
							paneIds: ["w1:p1"],
						},
						{
							kind: "pull_request_state",
							url: livePr.url,
							states: ["open"],
						},
						{ kind: "pull_request_head", url: livePr.url, sha: "new" },
						{ kind: "path_exists", path, exists: true },
					],
				},
				env,
			),
		)
		expect(failures).toEqual([])
	})

	test("report every fact that changed", async () => {
		panes = [
			runtimePane({ paneId: "w1:p1", tabId: "w1:t1", agentStatus: "working" }),
			runtimePane({ paneId: "w1:p3", tabId: "w1:t1" }),
		]
		const failures = await run((executor) =>
			executor.checkPreconditions(
				{
					...base(),
					type: "open_url",
					payload: { url: "https://example.com" },
					preconditions: [
						{
							kind: "document_revision",
							path: join(root, "tasks/alpha/TASK.md"),
							sha256: "old",
						},
						{
							kind: "item_status",
							unit: "execution-unit:task/alpha",
							statuses: ["done"],
						},
						{
							kind: "item_archived",
							unit: "execution-unit:task/alpha",
							archived: true,
						},
						{
							kind: "item_status",
							unit: "execution-unit:task/missing",
							statuses: ["working"],
						},
						{
							kind: "pane_matches",
							runtime: "herdr",
							paneId: "w1:p1",
							tabId: "w1:t1",
							cwd: null,
							agentSessionId: null,
							agentStatuses: ["idle"],
						},
						{
							kind: "pane_matches",
							runtime: "herdr",
							paneId: "w1:p9",
							tabId: "w1:t1",
							cwd: null,
							agentSessionId: null,
							agentStatuses: ["idle"],
						},
						{
							kind: "tab_agent_panes",
							runtime: "herdr",
							tabId: "w1:t1",
							paneIds: ["w1:p1"],
						},
						{ kind: "pull_request_head", url: livePr.url, sha: "reviewed" },
						{
							kind: "path_exists",
							path: join(root, "nope"),
							exists: true,
						},
					],
				},
				env,
			),
		)
		expect(failures).toEqual([
			`${join(root, "tasks/alpha/TASK.md")} changed`,
			"alpha is now working",
			"alpha is no longer archived",
			"missing no longer exists",
			"The pull request head changed since it was reviewed",
			`${join(root, "nope")} no longer exists`,
			"The agent in pane w1:p1 is working",
			"Pane w1:p9 is gone",
			"Tab w1:t1's agent panes changed",
		])
		expect(prReads).toEqual([{ url: livePr.url, fresh: true }])
	})
})

describe("SupervisorExecutor actions", () => {
	test("re-resolves agency templates, asks for inputs, runs, and logs", async () => {
		await fakeAgency({
			id: "rename",
			description: "Rename",
			icon: "x",
			color: "x",
			available: true,
			inputs: [
				{ id: "id", label: "New item ID", required: true },
				{ id: "note", label: "Note", required: false, option: "--note" },
				{ id: "skip", label: "Skip", required: false, option: "--skip" },
			],
			commandTemplate: ["agency", "task", "rename", "alpha", "<id>"],
			followUpCommands: [["agency", "sync", "alpha"]],
		})
		const action = agencyAction("rename", {
			command: null,
			commandTemplate: ["agency", "never", "<id>"],
		})
		const first = await run((executor) =>
			executor.resolve(action, {}, options()),
		)
		expect(first).toMatchObject({
			kind: "inputs",
			inputs: [
				{ id: "id", required: true },
				{ id: "note", required: false },
				{ id: "skip", required: false },
			],
		})
		const result = await run((executor) =>
			Effect.gen(function* () {
				const resolution = yield* executor.resolve(
					action,
					{ id: "beta", note: "hi there", skip: "" },
					options(),
				)
				if (resolution.kind !== "ready") throw new Error(resolution.kind)
				expect(resolution.plan.preview).toEqual([
					"agency task rename alpha beta --note 'hi there'",
					"agency sync alpha",
				])
				return yield* confirmAndExecute(executor, resolution.plan, "item")
			}),
		)
		expect(result).toEqual({
			outcome: "succeeded",
			detail: "ran sync",
			fallback: null,
			logError: null,
		})
		expect(await Bun.file(join(tempDir, "ran.log")).text()).toBe(
			"task rename alpha beta --note hi there\nsync alpha\n",
		)
		expect(await actionLog()).toMatchObject([
			{ key: "item", actionId: "signal/action", outcome: "succeeded" },
		])
	})

	test("reports a blocked agency action as unavailable", async () => {
		await fakeAgency({
			id: "archive",
			description: "Archive",
			icon: "x",
			color: "x",
			available: false,
			blockedReason: "Item and all children must be terminal",
		})
		const resolution = await run((executor) =>
			executor.resolve(agencyAction("archive"), {}, options()),
		)
		expect(resolution).toEqual({
			kind: "unavailable",
			reason: "Item and all children must be terminal",
			fallback: null,
		})
	})

	test("launches work in a new unfocused tab", async () => {
		await fakeAgency({
			id: "work",
			description: "Work",
			icon: "x",
			color: "x",
			available: true,
			command: ["agency", "work", "--task", "alpha", "--auto"],
		})
		const result = await run((executor) =>
			Effect.gen(function* () {
				const resolution = yield* executor.resolve(
					agencyAction("work"),
					{},
					options(),
				)
				if (resolution.kind !== "ready") throw new Error(resolution.kind)
				return yield* confirmAndExecute(executor, resolution.plan, null)
			}),
		)
		expect(result.outcome).toBe("succeeded")
		expect(calls).toEqual([
			[
				"launch",
				{
					workspaceId: "w1",
					cwd: join(root, "tasks/alpha"),
					label: "alpha",
					command: `sh ${agencyCommand[1]} work --task alpha --auto`,
				},
			],
		])
	})

	test("binds an adopted pane to the task it creates", async () => {
		await fakeAgency({
			id: "task-create",
			description: "Create",
			icon: "x",
			color: "x",
			available: true,
			inputs: [{ id: "id", label: "Task ID", required: true }],
			commandTemplate: ["agency", "task", "create", "<id>"],
		})
		const ref = {
			runtime: "herdr" as const,
			paneId: "w1:p5",
			tabId: "w1:t5",
			workspaceId: "w1",
			agent: "opencode",
			agentSessionId: "ses_5",
		}
		const result = await run((executor) =>
			Effect.gen(function* () {
				const resolution = yield* executor.resolve(
					agencyAction("task-create", {
						selector: null,
						bindRuntime: ref,
						command: null,
						commandTemplate: ["agency", "task", "create", "<id>"],
					}),
					{ id: "adopted" },
					options(),
				)
				if (resolution.kind !== "ready") throw new Error(resolution.kind)
				return yield* confirmAndExecute(executor, resolution.plan, null)
			}),
		)
		expect(result.detail).toBe("Created adopted and bound pane w1:p5")
		const bindings = await runTestEffect(
			Effect.flatMap(RuntimeBindingService, (service) =>
				service.list(root, env),
			),
		)
		expect(bindings).toMatchObject([
			{
				unit: "execution-unit:task/adopted",
				paneId: "w1:p5",
				agentSessionId: "ses_5",
			},
		])
	})

	test("skips a destructive close when the tab changed, without closing", async () => {
		panes = [
			runtimePane({ paneId: "w1:p1", tabId: "w1:t1" }),
			runtimePane({ paneId: "w1:p2", tabId: "w1:t1" }),
		]
		const close: SupervisorAction = {
			...base(),
			risk: "destructive",
			type: "runtime",
			preconditions: [
				{
					kind: "tab_agent_panes",
					runtime: "herdr",
					tabId: "w1:t1",
					paneIds: ["w1:p1"],
				},
			],
			payload: {
				runtime: "herdr",
				operation: "close",
				target: "tab",
				id: "w1:t1",
			},
		}
		const result = await run((executor) =>
			Effect.gen(function* () {
				const resolution = yield* executor.resolve(close, {}, options())
				if (resolution.kind !== "ready") throw new Error(resolution.kind)
				expect(resolution.plan.destructive).toBe(true)
				expect(resolution.plan.preview).toEqual(["herdr: close tab w1:t1"])
				return yield* confirmAndExecute(executor, resolution.plan, "item")
			}),
		)
		expect(result).toMatchObject({
			outcome: "skipped",
			detail: "Tab w1:t1's agent panes changed",
		})
		expect(calls).toEqual([])
		expect(await actionLog()).toMatchObject([
			{
				outcome: "failed",
				detail: "Precondition failed: Tab w1:t1's agent panes changed",
			},
		])
	})

	test("waits for a working agent and offers a kickoff only when it is blocked", async () => {
		panes = [runtimePane({ paneId: "w1:p1", agentStatus: "working" })]
		const busy = await run((executor) =>
			runAction(executor, {
				...base(),
				type: "prompt_agent",
				payload: {
					runtime: "herdr",
					paneId: "w1:p1",
					agentSessionId: null,
					prompt: "Rebase onto main",
				},
			}),
		)
		expect(busy).toMatchObject({
			outcome: "skipped",
			detail: "The agent in pane w1:p1 is working; try again once it settles",
			fallback: null,
		})
		panes = [runtimePane({ paneId: "w1:p1", agentStatus: "blocked" })]
		const prompt: SupervisorAction = {
			...base(),
			type: "prompt_agent",
			payload: {
				runtime: "herdr",
				paneId: "w1:p1",
				agentSessionId: null,
				prompt: "Rebase onto main",
			},
		}
		const result = await run((executor) =>
			Effect.gen(function* () {
				const resolution = yield* executor.resolve(prompt, {}, options())
				if (resolution.kind !== "ready") throw new Error(resolution.kind)
				return yield* confirmAndExecute(executor, resolution.plan, null)
			}),
		)
		expect(result).toMatchObject({
			outcome: "skipped",
			detail: "The agent in pane w1:p1 is blocked by a dialog",
			fallback: {
				type: "delegate",
				payload: {
					unit: "execution-unit:task/alpha",
					instructions: "Rebase onto main",
					via: "kickoff",
				},
			},
		})
		agencyCommand = ["agency"]
		await run((executor) =>
			Effect.gen(function* () {
				const resolution = yield* executor.resolve(
					result.fallback!,
					{},
					options(),
				)
				if (resolution.kind !== "ready") throw new Error(resolution.kind)
				expect(resolution.plan.preview[1]).toBe(
					"agency work --task alpha --auto --instructions 'Rebase onto main'",
				)
				return yield* confirmAndExecute(executor, resolution.plan, null)
			}),
		)
		expect(calls).toEqual([
			[
				"launch",
				{
					workspaceId: "w1",
					cwd: join(root, "tasks/alpha"),
					label: "alpha",
					command:
						'agency work --task alpha --auto --instructions "$AGENCY_SUPERVISOR_INSTRUCTIONS"',
					env: { AGENCY_SUPERVISOR_INSTRUCTIONS: "Rebase onto main" },
				},
			],
		])
	})

	test("prompts an idle bound agent and falls back when it is blocked", async () => {
		panes = [runtimePane({ paneId: "w1:p1", agentStatus: "idle" })]
		const delegate: SupervisorAction = {
			...base(),
			subject: {
				...subject(),
				runtime: [
					{
						runtime: "herdr",
						paneId: "w1:p1",
						tabId: "w1:t1",
						workspaceId: "w1",
						agent: "opencode",
						agentSessionId: null,
					},
				],
			},
			type: "delegate",
			payload: {
				unit: "execution-unit:task/alpha",
				instructions: "Continue",
				via: "prompt_bound_agent",
			},
		}
		const executeOnce = () =>
			run((executor) =>
				Effect.gen(function* () {
					const resolution = yield* executor.resolve(delegate, {}, options())
					if (resolution.kind !== "ready") throw new Error(resolution.kind)
					return yield* confirmAndExecute(executor, resolution.plan, null)
				}),
			)
		expect((await executeOnce()).outcome).toBe("succeeded")
		expect(calls).toEqual([["prompt", "w1:p1", "Continue"]])

		failures = { prompt: "agent_blocked" }
		const blocked = await executeOnce()
		expect(blocked).toMatchObject({
			outcome: "failed",
			fallback: { type: "delegate", payload: { via: "kickoff" } },
		})

		panes = []
		const gone = await run((executor) =>
			executor.resolve(delegate, {}, options()),
		)
		expect(gone).toMatchObject({
			kind: "unavailable",
			reason: "No live agent is bound to execution-unit:task/alpha",
			fallback: { payload: { via: "kickoff" } },
		})
	})
})

describe("SupervisorExecutor safeguards", () => {
	const close = (): SupervisorAction => ({
		...base(),
		risk: "destructive",
		type: "runtime",
		payload: {
			runtime: "herdr",
			operation: "close",
			target: "pane",
			id: "w1:p1",
		},
	})

	test("runs only plans confirmed through confirm, twice when destructive", async () => {
		panes = [runtimePane({ paneId: "w1:p1" })]
		const outcomes = await run((executor) =>
			Effect.gen(function* () {
				const resolution = yield* executor.resolve(close(), {}, options())
				if (resolution.kind !== "ready") throw new Error(resolution.kind)
				const once = yield* Effect.flip(
					executor.confirm(
						resolution.plan,
						{ confirmed: true, destructiveConfirmed: false },
						"item",
						options(),
					),
				)
				const declined = yield* Effect.flip(
					executor.confirm(
						resolution.plan,
						{ confirmed: false, destructiveConfirmed: false },
						"item",
						options(),
					),
				)
				const forged = yield* executor.execute(
					{ plan: resolution.plan } as unknown as Parameters<
						typeof executor.execute
					>[0],
					"item",
					options(),
				)
				const token = yield* executor.confirm(
					resolution.plan,
					{ confirmed: true, destructiveConfirmed: true },
					"item",
					options(),
				)
				const first = yield* executor.execute(token, "item", options())
				const replay = yield* executor.execute(token, "item", options())
				return [once.message, declined.message, forged, first, replay]
			}),
		)
		expect(outcomes).toMatchObject([
			"The destructive action was not confirmed twice",
			"The action was not confirmed",
			{ outcome: "failed", detail: "The action was not confirmed" },
			{ outcome: "succeeded" },
			{ outcome: "failed", detail: "The action was not confirmed" },
		])
		expect(calls).toEqual([["close", "pane", "w1:p1"]])
		expect((await actionLog()).map((entry) => entry.outcome)).toEqual([
			"cancelled",
			"cancelled",
			"failed",
			"succeeded",
			"failed",
		])
	})

	test("rejects malformed actions and unknown preconditions", async () => {
		const invalid = await run((executor) =>
			Effect.flip(
				executor.resolve({ ...close(), type: "teleport" }, {}, options()),
			),
		)
		expect(invalid.message).toStartWith("Invalid action:")
		const failures = await run((executor) =>
			executor.checkPreconditions(
				{
					...close(),
					preconditions: [
						{ kind: "moon_phase" } as unknown as ActionPrecondition,
						{
							kind: "tab_agent_panes",
							runtime: "tmux",
							tabId: "w1:t1",
							paneIds: [],
						} as unknown as ActionPrecondition,
						{
							kind: "ticket_status_category",
							url: "https://acme.atlassian.net/browse/CAN-1",
							statusCategories: ["done"],
						},
					],
				},
				env,
			),
		)
		expect(failures).toEqual([
			'Unknown precondition: {"kind":"moon_phase"}',
			"CAN-1 is now In Progress",
			"The action targets tmux, but the runtime is herdr",
		])
		expect(ticketReads).toEqual([
			{ url: "https://acme.atlassian.net/browse/CAN-1", fresh: true },
		])
	})

	test("refuses agency command actions and unsafe URLs", async () => {
		const resolutions = await run((executor) =>
			Effect.all(
				[
					{
						...base(),
						type: "command",
						payload: { argv: ["agency", "task", "status"], cwd: null },
					},
					{
						...base(),
						type: "open_url",
						payload: { url: "file:///etc/passwd" },
					},
					{ ...base(), type: "open_url", payload: { url: "-a Terminal" } },
					{
						...base(),
						type: "open_url",
						payload: { url: "https://github.com/acme/agency/pull/1" },
					},
				].map((action) => executor.resolve(action, {}, options())),
			),
		)
		expect(resolutions.map((item) => item.kind)).toEqual([
			"unavailable",
			"unavailable",
			"unavailable",
			"ready",
		])
	})

	test("skips an agency action whose discovered command changed after preview", async () => {
		await fakeAgency({
			id: "sync",
			description: "Sync",
			icon: "x",
			color: "x",
			available: true,
			command: ["agency", "sync", "alpha"],
		})
		const result = await run((executor) =>
			Effect.gen(function* () {
				const resolution = yield* executor.resolve(
					agencyAction("sync"),
					{},
					options(),
				)
				if (resolution.kind !== "ready") throw new Error(resolution.kind)
				yield* Effect.promise(() =>
					Bun.write(
						join(tempDir, "discovery.json"),
						discovery({
							id: "sync",
							description: "Sync",
							icon: "x",
							color: "x",
							available: true,
							command: ["agency", "sync", "beta"],
						}),
					),
				)
				return yield* confirmAndExecute(executor, resolution.plan, null)
			}),
		)
		expect(result).toMatchObject({
			outcome: "skipped",
			detail: "'sync' changed since it was previewed",
		})
		expect(await Bun.file(join(tempDir, "ran.log")).exists()).toBe(false)
	})

	test("never prompts a reused pane hosting a different agent session", async () => {
		panes = [runtimePane({ paneId: "w1:p1", agentSessionId: "ses_new" })]
		const prompt = await run((executor) =>
			runAction(executor, {
				...base(),
				type: "prompt_agent",
				payload: {
					runtime: "herdr",
					paneId: "w1:p1",
					agentSessionId: "ses_old",
					prompt: "Continue",
				},
			}),
		)
		expect(prompt).toMatchObject({
			outcome: "skipped",
			detail: "Pane w1:p1 now hosts a different agent session",
			fallback: { payload: { via: "kickoff" } },
		})
		await runTestEffect(
			Effect.flatMap(RuntimeBindingService, (service) =>
				service.record(
					{
						root,
						unit: "execution-unit:task/alpha",
						runtime: "herdr",
						paneId: "w1:p1",
						tabId: "w1:t1",
						workspaceId: "w1",
						agent: "opencode",
						agentSessionId: "ses_old",
						agencySessionId: null,
					},
					env,
				),
			),
		)
		const delegate = await run((executor) =>
			executor.resolve(
				{
					...base(),
					subject: {
						...subject(),
						runtime: [
							{
								runtime: "herdr",
								paneId: "w1:p1",
								tabId: "w1:t1",
								workspaceId: "w1",
								agent: "opencode",
								agentSessionId: "ses_old",
							},
						],
					},
					type: "delegate",
					payload: {
						unit: "execution-unit:task/alpha",
						instructions: "Continue",
						via: "prompt_bound_agent",
					},
				},
				{},
				options(),
			),
		)
		expect(delegate).toMatchObject({
			kind: "unavailable",
			reason: "No live agent is bound to execution-unit:task/alpha",
		})
		expect(calls).toEqual([])
	})

	test("reports action log write failures", async () => {
		await write(join(tempDir, "not-a-directory"), "")
		env = { ...env, AGENCY_STATE_DIR: join(tempDir, "not-a-directory") }
		panes = [runtimePane({ paneId: "w1:p1" })]
		const result = await run((executor) =>
			runAction(executor, {
				...base(),
				type: "runtime",
				payload: {
					runtime: "herdr",
					operation: "focus",
					target: "pane",
					id: "w1:p1",
				},
			}),
		)
		expect(result.outcome).toBe("succeeded")
		expect(result.logError).toStartWith("Unable to write the action log:")
	})
})

describe("SupervisorExecutor risk floor", () => {
	const resolvedRisk = (
		action: unknown,
		source?: "signal" | "triage" | "model",
	) =>
		run((executor) =>
			Effect.map(
				executor.resolve(action, {}, options(), source),
				(resolution) =>
					resolution.kind === "ready"
						? [resolution.plan.action.risk, resolution.plan.destructive]
						: resolution.kind,
			),
		)

	test("makes model-written commands and agency actions destructive", async () => {
		await fakeAgency({
			id: "sync",
			description: "Sync",
			icon: "x",
			color: "x",
			available: true,
			command: ["agency", "sync", "alpha"],
		})
		const merge = {
			...base(),
			id: "triage:merge",
			type: "command",
			payload: {
				argv: ["gh", "pr", "merge", "https://github.com/acme/agency/pull/1"],
				cwd: null,
			},
		}
		expect(await resolvedRisk(merge, "model")).toEqual(["destructive", true])
		expect(await resolvedRisk(merge, "signal")).toEqual(["reversible", false])
		expect(await resolvedRisk(agencyAction("sync"), "model")).toEqual([
			"destructive",
			true,
		])
	})

	test("always treats a runtime close as destructive", async () => {
		const close = {
			...base(),
			type: "runtime",
			payload: {
				runtime: "herdr",
				operation: "close",
				target: "tab",
				id: "w1:t1",
			},
		}
		for (const source of ["signal", "triage", "model"] as const)
			expect(await resolvedRisk(close, source)).toEqual(["destructive", true])
		panes = [runtimePane({ paneId: "w1:p1", tabId: "w1:t1" })]
		const once = await run((executor) =>
			Effect.gen(function* () {
				const resolution = yield* executor.resolve(
					close,
					{},
					options(),
					"model",
				)
				if (resolution.kind !== "ready") throw new Error(resolution.kind)
				return yield* Effect.flip(
					executor.confirm(
						resolution.plan,
						{ confirmed: true, destructiveConfirmed: false },
						null,
						options(),
					),
				)
			}),
		)
		expect(once.message).toBe("The destructive action was not confirmed twice")
		expect(calls).toEqual([])
	})

	test("refuses commands that run Agency by path or package runner", async () => {
		const kinds = await run((executor) =>
			Effect.all(
				[
					["/usr/local/bin/agency", "task", "status"],
					["bunx", "agency", "archive"],
					["npx", "-y", "@markjaquith/agency@latest", "sync"],
					["bunx", "cowsay", "agency"],
				].map((argv) =>
					Effect.map(
						executor.resolve(
							{ ...base(), type: "command", payload: { argv, cwd: null } },
							{},
							options(),
						),
						(resolution) => resolution.kind,
					),
				),
			),
		)
		expect(kinds).toEqual([
			"unavailable",
			"unavailable",
			"unavailable",
			"ready",
		])
	})
})
