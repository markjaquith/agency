import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import Ajv2020 from "ajv/dist/2020"
import addFormats from "ajv-formats"
import { Effect, Schema } from "effect"
import { chmod, mkdir, readdir, realpath } from "node:fs/promises"
import { dirname, join } from "node:path"
import actionSchema from "../../schemas/agency-action-v1.schema.json"
import reportSchema from "../../schemas/agency-triage-report-v1.schema.json"
import triageSchema from "../../schemas/agency-triage-v1.schema.json"
import { RuntimeBindingService } from "../services/RuntimeBindingService"
import { RuntimeService } from "../services/RuntimeService"
import { SupervisionStateService } from "../services/SupervisionStateService"
import { WorkbaseService } from "../services/WorkbaseService"
import {
	captureLogs,
	cleanupTempDir,
	createFakeRuntimeProvider,
	createTempDir,
	fakeRuntimeService,
	runTestEffect,
	runtimePane,
} from "../test-utils"
import { TriageReport } from "../triage-schema"
import { triage } from "./triage"

const write = async (root: string, path: string, content: string) => {
	const fullPath = join(root, path)
	await mkdir(dirname(fullPath), { recursive: true })
	await Bun.write(fullPath, content)
}

const task = (id: string, status: string) => `---
ticketUrl: null
repo: agency
branch: feat/${id}
base: main
pr: null
status: ${status}
---

# ${id}
`

/**
 * A fake `opencode run`: it records each invocation, answers from the attached
 * snapshot, and misbehaves on request through FAKE_OPENCODE_MODE.
 */
const fakeOpenCode = `#!/usr/bin/env bun
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
const args = process.argv.slice(2)
const log = process.env.FAKE_OPENCODE_LOG
const pick = (names) => Object.fromEntries(names.map((name) => [name, process.env[name] ?? null]))
const configDir = process.env.OPENCODE_CONFIG_DIR
appendFileSync(
	log,
	JSON.stringify({
		cwd: process.cwd(),
		args,
		env: pick([
			"PWD",
			"OPENCODE_CONFIG_DIR",
			"OPENCODE_DISABLE_PROJECT_CONFIG",
			"OPENCODE_SESSION_ID",
			"AGENCY_SESSION_ID",
			"AGENCY_STATE_DIR",
			"HERDR_PANE_ID",
			"HERDR_SOCKET_PATH",
		]),
		config: configDir ? readFileSync(configDir + "/opencode.jsonc", "utf8") : null,
	}) + "\\n",
)
const session = args[args.indexOf("--session") + 1]
const sessionId = args.includes("--session")
	? session
	: "ses_fake" + Math.random().toString(36).slice(2)
const files = args.flatMap((arg, index) => (args[index - 1] === "--file" ? [arg] : []))
const memory = log + "." + sessionId + ".json"
if (files[0]) writeFileSync(memory, readFileSync(files[0], "utf8"))
const snapshot = JSON.parse(readFileSync(memory, "utf8"))
const mode = process.env.FAKE_OPENCODE_MODE ?? "valid"
const emit = (event) => console.log(JSON.stringify({ sessionID: sessionId, ...event }))
if (mode === "error") {
	emit({ type: "error", error: { type: "provider.no-route", message: "Model unavailable" } })
	process.exit(1)
}
const valid = {
	version: 1,
	items: snapshot.items.map((item) => ({
		key: item.key,
		status: item.transcriptTails.length ? "needs_input" : "in_progress",
		summary: "Summary of " + item.key,
		question: item.transcriptTails[0]?.text.split("\\n").at(-1) ?? null,
		actions: item.signals.flatMap((signal) => signal.actions).slice(0, 1),
	})),
}
const modelAction = (item) =>
	item.panes.slice(0, 1).map((pane) => ({
		version: 1,
		id: "triage:" + item.key + ":look",
		type: "runtime",
		title: "Look at " + pane.paneId,
		rationale: "Check the question",
		risk: "reversible",
		subject: item.subject,
		preconditions: [
			{
				kind: "pane_matches",
				runtime: "herdr",
				paneId: pane.paneId,
				tabId: pane.tabId,
				cwd: pane.foregroundCwd ?? pane.cwd,
				agentSessionId: pane.agentSessionId,
				agentStatuses: ["idle"],
			},
		],
		payload: { runtime: "herdr", operation: "focus", target: "pane", id: pane.paneId },
	}))
if (mode === "model-action")
	for (const [index, item] of valid.items.entries())
		item.actions = [...modelAction(snapshot.items[index]), ...item.actions]
if (mode === "hang") await new Promise((resolve) => setTimeout(resolve, 60_000))
const retry = args.includes("--session")
const reply =
	mode === "invalid" || (mode === "invalid-then-valid" && !retry)
		? { version: 1, items: [{ key: "bogus", status: "unknown", summary: "x", question: null, actions: [] }] }
		: valid
emit({ type: "step_start", part: { messageID: "msg_1", type: "step-start" } })
emit({ type: "text", part: { messageID: "msg_0", type: "text", text: "thinking" } })
emit({ type: "text", part: { messageID: "msg_1", type: "text", text: "\`\`\`json\\n" + JSON.stringify(reply) } })
emit({ type: "text", part: { messageID: "msg_1", type: "text", text: "\\n\`\`\`" } })
`

let tempDir: string
let root: string
let configDirectory: string
let stateDirectory: string
let logPath: string
const saved: Record<string, string | undefined> = {}
const ENV = [
	"AGENCY_STATE_DIR",
	"AGENCY_OPENCODE_BIN",
	"AGENCY_SESSION_ID",
	"FAKE_OPENCODE_LOG",
	"FAKE_OPENCODE_MODE",
	"HERDR_PANE_ID",
	"HERDR_SOCKET_PATH",
	"OPENCODE_CONFIG_DIR",
	"OPENCODE_SESSION_ID",
]

beforeEach(async () => {
	tempDir = await realpath(await createTempDir())
	root = join(tempDir, "workbase")
	configDirectory = join(tempDir, "config")
	stateDirectory = join(tempDir, "state")
	logPath = join(tempDir, "opencode.log")
	const bin = join(tempDir, "opencode")
	await Bun.write(bin, fakeOpenCode)
	await chmod(bin, 0o755)
	for (const name of ENV) saved[name] = process.env[name]
	process.env.AGENCY_STATE_DIR = stateDirectory
	process.env.AGENCY_OPENCODE_BIN = bin
	process.env.FAKE_OPENCODE_LOG = logPath
	delete process.env.FAKE_OPENCODE_MODE
	// The invoking session's identity must not reach the triage agent.
	process.env.AGENCY_SESSION_ID = "agency-session"
	process.env.OPENCODE_SESSION_ID = "ses_parent"
	process.env.HERDR_PANE_ID = "w9:p9"
	process.env.HERDR_SOCKET_PATH = "/tmp/herdr.sock"
	process.env.OPENCODE_CONFIG_DIR = join(tempDir, "user-opencode")
	await write(
		tempDir,
		"user-opencode/opencode.jsonc",
		`{
	// The user's own model and plugins.
	"model": "user/model",
	"providers": { "user": { "settings": { "apiKey": "{env:KEY}" } } },
	"plugins": ["user-plugin"],
	"permissions": [{ "action": "*", "resource": "*", "effect": "allow" }],
}`,
	)
	await write(
		root,
		"agency.json",
		JSON.stringify({
			version: 2,
			triage: { prompt: "Workbase rule: prefer rebasing." },
		}),
	)
	await mkdir(join(root, "repos/agency"), { recursive: true })
	await write(root, "tasks/live/TASK.md", task("live", "working"))
	await write(root, "tasks/orphan/TASK.md", task("orphan", "working"))
	await write(root, "tasks/idle/TASK.md", task("idle", "open"))
	await write(
		configDirectory,
		"agency/agency.json",
		JSON.stringify({
			triage: { promptFile: "triage.md", model: "test/model" },
		}),
	)
	await write(configDirectory, "agency/triage.md", "Global rule: be brief.")
	await runTestEffect(
		Effect.flatMap(WorkbaseService, (service) =>
			service.register(root, configDirectory, "main"),
		),
	)
	await runTestEffect(
		Effect.flatMap(RuntimeBindingService, (service) =>
			service.record({
				root,
				unit: "execution-unit:task/live",
				runtime: "herdr",
				paneId: "w1:p1",
				tabId: "w1:t1",
				workspaceId: "w1",
				agent: "opencode",
				agentSessionId: "ses_live",
				agencySessionId: null,
			}),
		),
	)
})

afterEach(async () => {
	for (const name of ENV) {
		if (saved[name] === undefined) delete process.env[name]
		else process.env[name] = saved[name]
	}
	await cleanupTempDir(tempDir)
})

const panes = () => [
	runtimePane({
		paneId: "w1:p1",
		tabId: "w1:t1",
		agentSessionId: "ses_live",
		agentStatus: "idle",
		cwd: join(root, "tasks/live"),
	}),
	runtimePane({
		paneId: "w1:p5",
		tabId: "w1:t5",
		agentStatus: "working",
		cwd: join(tempDir),
	}),
]

const validators = () => {
	const ajv = new Ajv2020({ allErrors: true, strict: false })
	addFormats(ajv)
	ajv.addSchema(actionSchema)
	ajv.addSchema(triageSchema)
	return { report: ajv.compile(reportSchema) }
}

const run = async (
	options: {
		readonly item?: string
		readonly transcript?: string
	} = {},
) => {
	const logs = await captureLogs(() =>
		runTestEffect(
			triage({
				cwd: tempDir,
				json: true,
				configDirectory,
				item: options.item,
			}).pipe(
				Effect.provideService(
					RuntimeService,
					fakeRuntimeService(
						createFakeRuntimeProvider({
							panes: panes(),
							transcripts: {
								"w1:p1":
									options.transcript ??
									"Working...\n\nShould I rebase onto main?\n\n",
							},
						}),
					),
				),
			),
		),
	)
	expect(logs).toHaveLength(1)
	const json = JSON.parse(logs[0]!)
	const { report } = validators()
	expect(report(json) ? [] : report.errors).toEqual([])
	return Schema.decodeUnknownSync(TriageReport, {
		onExcessProperty: "error",
	})(json)
}

const calls = async () => {
	const file = Bun.file(logPath)
	if (!(await file.exists())) return []
	return (await file.text())
		.trim()
		.split("\n")
		.map(
			(line) =>
				JSON.parse(line) as {
					readonly cwd: string
					readonly args: string[]
					readonly env: Record<string, string | null>
					readonly config: string
				},
		)
}

/** Snapshots the fake saved from each run's attachments. */
const snapshots = async () =>
	Promise.all(
		(await readdir(tempDir))
			.filter((name) => /^opencode\.log\..+\.json$/.test(name))
			.map(async (name) =>
				JSON.parse(await Bun.file(join(tempDir, name)).text()),
			),
	)

const liveKey = () => `${root}:execution-unit:task/live`

describe("agency triage", () => {
	test("assesses supervised items through the read-only OpenCode agent", async () => {
		const report = await run()
		expect(report.items.map((item) => [item.key, item.source])).toEqual([
			[liveKey(), "fresh"],
			[`${root}:execution-unit:task/orphan`, "fresh"],
			["herdr:w1:p5", "fresh"],
		])
		const live = report.items[0]!
		expect(live.assessment).toMatchObject({
			status: "needs_input",
			question: "Should I rebase onto main?",
		})
		expect(live.subject.runtime.map((ref) => ref.paneId)).toEqual(["w1:p1"])
		expect(report.items[1]!.assessment!.actions[0]).toMatchObject({
			type: "agency",
			payload: { actionId: "work" },
		})
		expect(report.summary).toEqual({
			total: 3,
			fresh: 3,
			cached: 0,
			stale: 0,
			failed: 0,
		})

		// One run per workbase: the registered one and the unowned pane.
		const invocations = await calls()
		expect(invocations).toHaveLength(2)
		for (const invocation of invocations) {
			expect(invocation.args.slice(0, 10)).toEqual([
				"run",
				"--standalone",
				"--agent",
				"agency-triage",
				"--format",
				"json",
				"--title",
				"Agency triage",
				"--model",
				"test/model",
			])
			// Each run is isolated: its own project directory and OpenCode
			// config, outside the state directory, with no inherited identity.
			expect(invocation.env).toEqual({
				PWD: invocation.cwd,
				OPENCODE_CONFIG_DIR: join(invocation.cwd, ".config"),
				OPENCODE_DISABLE_PROJECT_CONFIG: "1",
				OPENCODE_SESSION_ID: null,
				AGENCY_SESSION_ID: null,
				AGENCY_STATE_DIR: null,
				HERDR_PANE_ID: null,
				HERDR_SOCKET_PATH: "/tmp/herdr.sock",
			})
			expect(invocation.cwd.startsWith(stateDirectory)).toBe(false)
			expect(await Bun.file(invocation.cwd).exists()).toBe(false)
			const attached = invocation.args.filter(
				(_, index, args) => args[index - 1] === "--file",
			)
			expect(attached.map((file) => dirname(file))).toEqual([
				invocation.cwd,
				invocation.cwd,
				invocation.cwd,
			])
			const config = JSON.parse(invocation.config)
			expect(config.model).toBe("user/model")
			expect(config.providers).toEqual({
				user: { settings: { apiKey: "{env:KEY}" } },
			})
			expect(config.plugins).toBeUndefined()
			expect(config.permissions).toBeUndefined()
			expect(config.agents["agency-triage"].permissions[0]).toEqual({
				action: "*",
				resource: "*",
				effect: "deny",
			})
		}
		const messages = invocations.map((invocation) => invocation.args.at(-1)!)
		const message = messages.find((text) => text.includes("Workbase rule"))!
		expect(message).toContain("Global rule: be brief.")
		expect(message.indexOf("Global rule")).toBeLessThan(
			message.indexOf("Workbase rule: prefer rebasing."),
		)
		const unowned = messages.find((text) => text !== message)!
		expect(unowned).toContain("Global rule: be brief.")
		expect(unowned).not.toContain("Workbase rule")
		// Only the workbase batch may read the workbase.
		const reads = (invocation: (typeof invocations)[number]) =>
			JSON.parse(invocation.config)
				.agents["agency-triage"].permissions.filter(
					(rule: { action: string; effect: string }) =>
						rule.action === "read" && rule.effect === "allow",
				)
				.map((rule: { resource: string }) => rule.resource)
		const workbaseRun = invocations.find((invocation) =>
			invocation.args.at(-1)!.includes("Workbase rule"),
		)!
		expect(reads(workbaseRun)).toEqual(["*", `${root}/*`])
		expect(
			reads(invocations.find((invocation) => invocation !== workbaseRun)!),
		).toEqual(["*"])
	})

	test("accepts checked model-written actions and marks them", async () => {
		process.env.FAKE_OPENCODE_MODE = "model-action"
		const report = await run({ item: "live" })
		expect(report.items[0]!.assessment).toMatchObject({
			actions: [{ id: `triage:${liveKey()}:look` }, { type: "runtime" }],
			modelActionIds: [`triage:${liveKey()}:look`],
		})
		expect(await calls()).toHaveLength(1)
	})

	test("re-evaluates only items whose state changed", async () => {
		await run()
		expect(await calls()).toHaveLength(2)

		const cached = await run()
		expect(cached.items.map((item) => item.source)).toEqual([
			"cached",
			"cached",
			"cached",
		])
		expect(await calls()).toHaveLength(2)

		const changed = await run({ transcript: "Done. Anything else?" })
		expect(changed.items.map((item) => item.source)).toEqual([
			"fresh",
			"cached",
			"cached",
		])
		expect(changed.items[0]!.assessment!.question).toBe("Done. Anything else?")
		expect(await calls()).toHaveLength(3)
	})

	test("applies supervisor feedback per item", async () => {
		const first = await run()
		const orphan = first.items[1]!
		const dropped = orphan.assessment!.actions[0]!.id
		await runTestEffect(
			Effect.gen(function* () {
				const state = yield* SupervisionStateService
				for (const key of [liveKey(), "elsewhere"])
					yield* state.appendAction({
						key,
						actionId: "focus",
						type: "runtime",
						title: "Focus pane",
						outcome: "succeeded",
						detail: null,
					})
				yield* state.snooze({
					key: liveKey(),
					actionId: null,
					until: "2999-01-01T00:00:00Z",
					reason: "later",
				})
				yield* state.dismiss({
					key: orphan.key,
					actionId: dropped,
					fingerprint: orphan.fingerprint,
					reason: null,
				})
				yield* state.dismiss({
					key: liveKey(),
					actionId: "lapsed",
					fingerprint: "an-earlier-state",
					reason: null,
				})
				// Supervisor dismissals pin `<signals>:<triage>`; triage compares
				// its own part, or the signal part when it has none.
				yield* state.dismiss({
					key: orphan.key,
					actionId: "composite-kept",
					fingerprint: `0123456789abcdef:${orphan.fingerprint}`,
					reason: null,
				})
				yield* state.dismiss({
					key: orphan.key,
					actionId: "composite-pruned",
					fingerprint: "0123456789abcdef:",
					reason: null,
				})
			}),
		)

		const report = await run()
		// The action log changed only the live item; dismissals and snoozes are
		// applied to results without re-running triage.
		expect(report.items.map((item) => item.source)).toEqual([
			"fresh",
			"cached",
			"cached",
		])
		expect(await calls()).toHaveLength(3)
		expect(report.items[0]).toMatchObject({
			suppressed: "snoozed",
			assessment: { actions: [] },
		})
		expect(report.items[1]!.suppressed).toBeNull()
		expect(
			report.items[1]!.assessment!.actions.map((action) => action.id),
		).not.toContain(dropped)

		const snapshot = (await snapshots()).find((entry) =>
			entry.items.some(
				(item: { recentActions: unknown[] }) => item.recentActions.length,
			),
		)!
		expect(snapshot.items).toHaveLength(1)
		expect(snapshot.items[0]).toMatchObject({
			key: liveKey(),
			recentActions: [{ key: liveKey(), actionId: "focus" }],
			snoozes: [{ key: liveKey(), reason: "later" }],
			// The lapsed dismissal is not sent.
			dismissals: [],
			transcriptTails: [
				{ paneId: "w1:p1", text: "Working...\n\nShould I rebase onto main?" },
			],
			previousAssessment: { status: "needs_input" },
		})
		// A full run prunes dismissals whose item state has moved on.
		const dismissals = await runTestEffect(
			Effect.flatMap(SupervisionStateService, (state) => state.dismissals()),
		)
		expect(dismissals.map((entry) => entry.actionId)).toEqual([
			dropped,
			"composite-kept",
		])
	})

	test("concurrent runs merge their cached results", async () => {
		const quiet = (item: string) =>
			runTestEffect(
				triage({ cwd: tempDir, silent: true, configDirectory, item }).pipe(
					Effect.provideService(
						RuntimeService,
						fakeRuntimeService(createFakeRuntimeProvider({ panes: panes() })),
					),
				),
			)
		await Promise.all([quiet("live"), quiet("orphan")])
		const cache = await runTestEffect(
			Effect.flatMap(SupervisionStateService, (state) => state.triageCache()),
		)
		expect(cache.map((entry) => entry.key).sort()).toEqual(
			[liveKey(), `${root}:execution-unit:task/orphan`].sort(),
		)
	})

	test("retries once with the validation errors", async () => {
		process.env.FAKE_OPENCODE_MODE = "invalid-then-valid"
		const report = await run({ item: "live" })
		expect(report.items).toHaveLength(1)
		expect(report.items[0]!.source).toBe("fresh")
		const invocations = await calls()
		expect(invocations).toHaveLength(2)
		const retry = invocations[1]!.args
		expect(retry).toContain("--session")
		expect(retry).not.toContain("--file")
		expect(retry.at(-1)).toContain('Unknown item key "bogus".')
		expect(retry.at(-1)).toContain(`Missing item key "${liveKey()}".`)
	})

	test("reports a structured failure after the retry fails", async () => {
		await run()
		process.env.FAKE_OPENCODE_MODE = "invalid"
		const report = await run({ item: "live" })
		expect(report.failures).toEqual([
			{
				workbase: { id: expect.any(String), name: "main", root },
				keys: [liveKey()],
				kind: "invalid_response",
				message: "The triage reply did not satisfy the response contract",
				errors: expect.arrayContaining(['Unknown item key "bogus".']),
				attempts: 2,
				sessionId: expect.stringMatching(/^ses_fake/),
			},
		])
		// The earlier assessment survives as stale.
		expect(report.items[0]).toMatchObject({
			source: "stale",
			assessment: { status: "needs_input" },
			error: "The triage reply did not satisfy the response contract",
		})
	})

	test("reports runner failures without retrying", async () => {
		process.env.FAKE_OPENCODE_MODE = "error"
		const report = await run({ item: "orphan" })
		expect(report.failures).toMatchObject([
			{ kind: "runner", message: "Model unavailable", attempts: 1 },
		])
		expect(report.items[0]).toMatchObject({
			source: "failed",
			assessment: null,
		})
		expect(await calls()).toHaveLength(1)
	})

	test("rejects an item selector that matches nothing", async () => {
		await expect(run({ item: "nope" })).rejects.toThrow(
			"No supervised item matches 'nope'",
		)
	})

	test("an interrupted CLI run stops opencode and removes its files", async () => {
		const marker = join(tempDir, "hang.pid")
		const hang = join(tempDir, "hang.sh")
		await Bun.write(hang, `#!/bin/sh\necho "$$ $PWD" > ${marker}\nsleep 60\n`)
		await chmod(hang, 0o755)
		const cli = Bun.spawn(
			[
				process.execPath,
				join(import.meta.dir, "../../cli.ts"),
				"triage",
				"--item",
				"orphan",
			],
			{
				cwd: root,
				env: {
					...process.env,
					AGENCY_OPENCODE_BIN: hang,
					XDG_CONFIG_HOME: configDirectory,
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		)
		const deadline = Date.now() + 20_000
		while (!(await Bun.file(marker).exists()) && Date.now() < deadline)
			await Bun.sleep(50)
		const [pid, directory] = (await Bun.file(marker).text()).trim().split(" ")
		cli.kill("SIGINT")
		expect(await cli.exited).toBe(130)
		const alive = (() => {
			try {
				process.kill(Number(pid), 0)
				return true
			} catch {
				return false
			}
		})()
		expect(alive).toBe(false)
		expect(await Bun.file(join(directory!, "snapshot.json")).exists()).toBe(
			false,
		)
	}, 30_000)
})
