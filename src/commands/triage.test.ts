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
appendFileSync(log, JSON.stringify({ cwd: process.cwd(), args }) + "\\n")
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
	"FAKE_OPENCODE_LOG",
	"FAKE_OPENCODE_MODE",
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
				JSON.parse(line) as { readonly cwd: string; readonly args: string[] },
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
		const directory = join(stateDirectory, "supervision/triage")
		for (const invocation of invocations) {
			expect(invocation.cwd).toBe(await realpath(directory))
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

		const config = JSON.parse(
			await Bun.file(join(directory, ".opencode/opencode.jsonc")).text(),
		)
		expect(config.agents["agency-triage"].permissions[0]).toEqual({
			action: "*",
			resource: "*",
			effect: "deny",
		})
		// Run inputs live outside the agent's project and are removed afterward.
		const attached = invocations[0]!.args.filter(
			(_, index, args) => args[index - 1] === "--file",
		)
		expect(attached).toHaveLength(3)
		for (const file of attached) {
			expect(file.startsWith(directory)).toBe(false)
			expect(await Bun.file(file).exists()).toBe(false)
		}
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

	test("feeds the action log, snoozes, and dismissals into the snapshot", async () => {
		await runTestEffect(
			Effect.gen(function* () {
				const state = yield* SupervisionStateService
				yield* state.appendAction({
					key: liveKey(),
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
			}),
		)
		await run()
		const snapshot = (await snapshots()).find(
			(entry) => entry.workbase !== null,
		)!
		expect(snapshot.recentActions).toEqual([
			expect.objectContaining({ actionId: "focus" }),
		])
		expect(snapshot.snoozes).toEqual([
			expect.objectContaining({ key: liveKey(), reason: "later" }),
		])
		expect(snapshot.items[0]).toMatchObject({
			key: liveKey(),
			transcriptTails: [
				{ paneId: "w1:p1", text: "Working...\n\nShould I rebase onto main?" },
			],
			previousAssessment: null,
		})
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
})
