import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { mkdir, realpath } from "node:fs/promises"
import { dirname, join } from "node:path"
import { AttentionReport } from "../attention-schema"
import {
	PullRequestStatusService,
	type LivePullRequest,
} from "../services/PullRequestStatusService"
import { RuntimeBindingService } from "../services/RuntimeBindingService"
import { RuntimeService } from "../services/RuntimeService"
import { WorkbaseService } from "../services/WorkbaseService"
import {
	attentionValidators,
	captureLogs,
	cleanupTempDir,
	createFakeRuntimeProvider,
	createTempDir,
	fakeRuntimeService,
	runTestEffect,
	runtimePane,
} from "../test-utils"
import type { RuntimePane } from "../workbase/runtime"
import { attention } from "./attention"

const write = async (root: string, path: string, content: string) => {
	const fullPath = join(root, path)
	await mkdir(dirname(fullPath), { recursive: true })
	await Bun.write(fullPath, content)
}

const task = (id: string, status: string, pr = "null") => `---
ticketUrl: null
repo: agency
branch: feat/${id}
base: main
pr: ${pr}
status: ${status}
---

# ${id}
`

const prUrl = "https://github.com/acme/agency/pull/7"

let tempDir: string
let root: string
let other: string
let configDirectory: string
const previousStateDirectory = process.env.AGENCY_STATE_DIR

beforeEach(async () => {
	tempDir = await realpath(await createTempDir())
	root = join(tempDir, "workbase")
	other = join(tempDir, "unregistered")
	configDirectory = join(tempDir, "config")
	process.env.AGENCY_STATE_DIR = join(tempDir, "state")
	for (const base of [root, other]) {
		await write(base, "agency.json", '{"version":2}\n')
		await mkdir(join(base, "repos/agency"), { recursive: true })
	}
	await write(root, "tasks/live/TASK.md", task("live", "working"))
	await write(root, "tasks/orphan/TASK.md", task("orphan", "working"))
	await write(root, "tasks/merged/TASK.md", task("merged", "working", prUrl))
	await write(root, "tasks/finished/TASK.md", task("finished", "done"))
	await write(root, "archive/tasks/old/TASK.md", task("old", "done"))
	await write(other, "tasks/stray/TASK.md", task("stray", "open"))
	await mkdir(join(tempDir, "notes"))
	await runTestEffect(
		Effect.flatMap(WorkbaseService, (service) =>
			service.register(root, configDirectory, "main"),
		),
	)
})

afterEach(async () => {
	if (previousStateDirectory === undefined) delete process.env.AGENCY_STATE_DIR
	else process.env.AGENCY_STATE_DIR = previousStateDirectory
	await cleanupTempDir(tempDir)
})

const bind = (unit: string, paneId: string, tabId: string, session: string) =>
	runTestEffect(
		Effect.flatMap(RuntimeBindingService, (service) =>
			service.record({
				root,
				unit,
				runtime: "herdr",
				paneId,
				tabId,
				workspaceId: "w1",
				agent: "opencode",
				agentSessionId: session,
				agencySessionId: null,
			}),
		),
	)

const livePullRequests: PullRequestStatusService["Service"] = {
	read: (url) =>
		Effect.succeed<LivePullRequest>({
			state: "available",
			url,
			prState: "merged",
			draft: false,
			review: "approved",
			checks: "passing",
			mergeable: "unknown",
			mergeState: "UNKNOWN",
			headSha: "abc123",
		}),
	mergeMethod: () => Effect.succeed("squash"),
}

const run = async (
	panes: readonly RuntimePane[] | null,
	options: { readonly workbase?: string } = {},
) => {
	const logs = await captureLogs(() =>
		runTestEffect(
			attention({ cwd: tempDir, json: true, configDirectory, ...options }).pipe(
				Effect.provideService(
					RuntimeService,
					fakeRuntimeService(
						panes ? createFakeRuntimeProvider({ panes }) : null,
					),
				),
				Effect.provideService(PullRequestStatusService, livePullRequests),
			),
		),
	)
	expect(logs).toHaveLength(1)
	const json = JSON.parse(logs[0]!)
	const { report } = attentionValidators()
	expect(report(json) ? [] : report.errors).toEqual([])
	return Schema.decodeUnknownSync(AttentionReport, {
		onExcessProperty: "error",
	})(json)
}

describe("agency attention", () => {
	test("reports signals across registered and runtime-discovered workbases", async () => {
		await bind("execution-unit:task/live", "w1:p1", "w1:t1", "ses_live")
		await bind("execution-unit:task/finished", "w1:p2", "w1:t2", "ses_done")
		await bind("execution-unit:task/old", "w1:p3", "w1:t3", "ses_old")
		const report = await run([
			runtimePane({
				paneId: "w1:p1",
				tabId: "w1:t1",
				agentSessionId: "ses_live",
				agentStatus: "working",
				cwd: join(root, "tasks/live"),
			}),
			runtimePane({
				paneId: "w1:p2",
				tabId: "w1:t2",
				agentSessionId: "ses_done",
				cwd: join(root, "tasks/finished"),
			}),
			runtimePane({
				paneId: "w1:p3",
				tabId: "w1:t3",
				agentSessionId: "ses_old",
				cwd: join(root, "tasks/old"),
			}),
			runtimePane({
				paneId: "w1:p4",
				tabId: "w1:t4",
				agentSessionId: "ses_stray",
				agentStatus: "idle",
				cwd: join(other, "tasks/stray"),
			}),
			runtimePane({
				paneId: "w1:p5",
				tabId: "w1:t5",
				agentStatus: "working",
				cwd: join(tempDir, "notes"),
			}),
		])

		expect(report.workbases).toEqual([
			{
				id: expect.any(String),
				name: "main",
				root,
				source: "registered",
				available: true,
				error: null,
			},
			{
				id: null,
				name: null,
				root: other,
				source: "runtime",
				available: true,
				error: null,
			},
		])
		const summary = report.signals.map((signal) => [
			signal.kind,
			signal.subject.item?.taskId ?? signal.subject.runtime[0]?.paneId,
		])
		expect(summary).toEqual([
			["complete_session_open", "finished"],
			["complete_session_open", "old"],
			["pr_merged_item_open", "merged"],
			["claim_without_session", "orphan"],
			["agent_waiting", "stray"],
			["unmanaged_session", "w1:p5"],
		])
		const archived = report.signals.find(
			(signal) => signal.subject.item?.taskId === "old",
		)!
		expect(archived.subject.item).toMatchObject({
			archived: true,
			path: join(root, "archive/tasks/old/TASK.md"),
		})
		expect(archived.actions[0]).toMatchObject({
			type: "runtime",
			payload: { operation: "close", target: "tab", id: "w1:t3" },
		})
		const sync = report.signals.find(
			(signal) => signal.kind === "pr_merged_item_open",
		)!.actions[0]!
		expect(sync).toMatchObject({
			type: "agency",
			payload: { actionId: "sync", cwd: root },
		})
		const resume = report.signals.find(
			(signal) =>
				signal.kind === "claim_without_session" &&
				signal.subject.item?.taskId === "orphan",
		)!.actions[0]!
		expect(resume).toMatchObject({
			type: "agency",
			payload: {
				actionId: "work",
				command: ["agency", "work", "--task", "orphan", "--auto"],
			},
		})
		expect(report.summary.total).toBe(report.signals.length)
	})

	test("restricts supervision without claiming other workbases' panes", async () => {
		await mkdir(join(other, "notes"))
		await runTestEffect(
			Effect.gen(function* () {
				const service = yield* WorkbaseService
				yield* service.register(other, configDirectory, "other")
				yield* service.setDefault("main", configDirectory)
			}),
		)
		const report = await run(
			[
				runtimePane({
					paneId: "w1:p4",
					agentStatus: "working",
					cwd: join(other, "notes"),
				}),
				runtimePane({
					paneId: "w1:p5",
					agentStatus: "working",
					cwd: join(tempDir, "notes"),
				}),
			],
			{ workbase: "main" },
		)
		expect(report.workbases.map((workbase) => workbase.root)).toEqual([root])
		const panes = report.signals.flatMap((signal) =>
			signal.subject.runtime.map((ref) => ref.paneId),
		)
		expect(panes).not.toContain("w1:p4")
		expect(
			report.signals.find((signal) => signal.kind === "unmanaged_session"),
		).toMatchObject({
			subject: { workbase: { root }, runtime: [{ paneId: "w1:p5" }] },
		})
		expect(
			report.signals.every((signal) => signal.subject.workbase?.root === root),
		).toBe(true)
	})

	test("skips runtime signals without a runtime", async () => {
		const report = await run(null)
		expect(report.runtime).toEqual({
			provider: null,
			available: false,
			error: null,
		})
		expect(report.signals.map((signal) => signal.kind)).toEqual([
			"pr_merged_item_open",
		])
	})
})
