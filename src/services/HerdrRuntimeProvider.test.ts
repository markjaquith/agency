import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { join } from "node:path"
import { cleanupTempDir, createTempDir } from "../test-utils"
import { FileSystemService } from "./FileSystemService"
import { createHerdrRuntimeProvider } from "./HerdrRuntimeProvider"
import { RuntimeService } from "./RuntimeService"

type Result = { exitCode: number; stdout: string; stderr: string }

const fakeFs = (respond: (args: readonly string[]) => Result) => {
	const calls: (readonly string[])[] = []
	const timeouts: (number | undefined)[] = []
	const fs = {
		runCommand: (
			args: readonly string[],
			options?: { readonly timeoutMs?: number },
		) => {
			calls.push(args)
			timeouts.push(options?.timeoutMs)
			return Effect.succeed(respond(args))
		},
	} as unknown as FileSystemService["Service"]
	return { fs, calls, timeouts }
}

const ok = (stdout: unknown): Result => ({
	exitCode: 0,
	stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout),
	stderr: "",
})

const herdrError = (code: string, message: string): Result => ({
	exitCode: 1,
	stdout: JSON.stringify({ id: "cli", error: { code, message } }),
	stderr: "",
})

const herdrPane = {
	agent: "opencode",
	agent_session: {
		agent: "opencode",
		kind: "id",
		source: "herdr:opencode",
		value: "ses_a",
	},
	agent_status: "working",
	cwd: "/wb/tasks/alpha",
	focused: true,
	foreground_cwd: "/wb/tasks/alpha/code/agency",
	pane_id: "w1:p2",
	revision: 2,
	tab_id: "w1:t2",
	terminal_id: "term_1",
	terminal_title: "OC | Alpha",
	terminal_title_stripped: "OC | Alpha",
	workspace_id: "w1",
}

describe("Herdr runtime provider", () => {
	test("normalizes a validated snapshot", async () => {
		const { fs, calls, timeouts } = fakeFs(() =>
			ok({
				id: "cli:api:snapshot",
				result: {
					snapshot: {
						protocol: 22,
						workspaces: [
							{ workspace_id: "w1", label: "Main", focused: true, number: 1 },
						],
						tabs: [{ tab_id: "w1:t2", workspace_id: "w1", label: "alpha" }],
						panes: [
							herdrPane,
							{
								agent_status: "unknown",
								cwd: "/tmp",
								pane_id: "w1:p3",
								tab_id: "w1:t2",
								workspace_id: "w1",
							},
							{ ...herdrPane, pane_id: "w1:p4", agent_status: "napping" },
						],
					},
				},
			}),
		)
		const provider = createHerdrRuntimeProvider(fs, "/bin/herdr", {})
		const snapshot = await Effect.runPromise(provider.snapshot())
		expect(calls).toEqual([["/bin/herdr", "api", "snapshot"]])
		expect(timeouts).toEqual([5_000])
		expect(snapshot.workspaces).toEqual([
			{ workspaceId: "w1", label: "Main", focused: true },
		])
		expect(snapshot.tabs).toEqual([
			{ tabId: "w1:t2", workspaceId: "w1", label: "alpha", focused: false },
		])
		expect(snapshot.panes).toEqual([
			{
				paneId: "w1:p2",
				tabId: "w1:t2",
				workspaceId: "w1",
				agent: "opencode",
				agentSessionId: "ses_a",
				agentStatus: "working",
				cwd: "/wb/tasks/alpha",
				foregroundCwd: "/wb/tasks/alpha/code/agency",
				terminalTitle: "OC | Alpha",
				focused: true,
			},
			{
				paneId: "w1:p3",
				tabId: "w1:t2",
				workspaceId: "w1",
				agent: null,
				agentSessionId: null,
				agentStatus: "unknown",
				cwd: "/tmp",
				foregroundCwd: null,
				terminalTitle: null,
				focused: false,
			},
			expect.objectContaining({ paneId: "w1:p4", agentStatus: "unknown" }),
		])
	})

	test("fails with typed errors for Herdr errors and malformed responses", async () => {
		for (const [result, code] of [
			[herdrError("server_unavailable", "no server"), "server_unavailable"],
			[ok({ result: { snapshot: { panes: "nope" } } }), "invalid_response"],
		] as const) {
			const { fs } = fakeFs(() => result)
			const error = await Effect.runPromise(
				Effect.flip(createHerdrRuntimeProvider(fs, "herdr", {}).snapshot()),
			)
			expect(error).toMatchObject({
				_tag: "RuntimeError",
				runtime: "herdr",
				operation: "snapshot",
				code,
			})
		}
	})

	test("reads a bounded unwrapped transcript tail", async () => {
		const { fs, calls, timeouts } = fakeFs(() => ok("line one\nline two"))
		const provider = createHerdrRuntimeProvider(fs, "herdr", {})
		expect(await Effect.runPromise(provider.readTranscript("w1:p2"))).toBe(
			"line one\nline two",
		)
		await Effect.runPromise(provider.readTranscript("w1:p2", { lines: 50_000 }))
		expect(calls).toEqual([
			[
				"herdr",
				"pane",
				"read",
				"w1:p2",
				"--source",
				"recent-unwrapped",
				"--lines",
				"200",
			],
			[
				"herdr",
				"pane",
				"read",
				"w1:p2",
				"--source",
				"recent-unwrapped",
				"--lines",
				"2000",
			],
		])
		expect(timeouts).toEqual([5_000, 5_000])
		const missing = fakeFs(() =>
			herdrError("pane_not_found", "pane w1:zz not found"),
		)
		const error = await Effect.runPromise(
			Effect.flip(
				createHerdrRuntimeProvider(missing.fs, "herdr", {}).readTranscript(
					"w1:zz",
				),
			),
		)
		expect(error).toMatchObject({
			code: "pane_not_found",
			message: "pane w1:zz not found",
		})
	})

	test("waits for agent status and treats a timeout as no match", async () => {
		const matched = fakeFs(() =>
			ok({
				id: "cli:agent:wait",
				result: { type: "agent_info", agent: herdrPane },
			}),
		)
		const provider = createHerdrRuntimeProvider(matched.fs, "herdr", {})
		const pane = await Effect.runPromise(
			provider.waitForAgentStatus("w1:p2", ["idle", "blocked"], {
				timeoutMs: 500,
			}),
		)
		expect(pane?.agentSessionId).toBe("ses_a")
		// Only agent wait uses a long timeout: the wait itself plus slack.
		expect(matched.timeouts).toEqual([30_500])
		expect(matched.calls[0]).toEqual([
			"herdr",
			"agent",
			"wait",
			"w1:p2",
			"--until",
			"idle",
			"--until",
			"blocked",
			"--timeout",
			"500",
		])
		const timedOut = fakeFs(() => herdrError("timeout", "timed out"))
		expect(
			await Effect.runPromise(
				createHerdrRuntimeProvider(timedOut.fs, "herdr", {}).waitForAgentStatus(
					"w1:p2",
					["done"],
					{ timeoutMs: 1 },
				),
			),
		).toBeNull()
	})

	test("reports the current location only inside Herdr", () => {
		const { fs } = fakeFs(() => ok(""))
		expect(
			createHerdrRuntimeProvider(fs, "herdr", {
				HERDR_ENV: "1",
				HERDR_PANE_ID: "w1:p2",
				HERDR_TAB_ID: "w1:t2",
				HERDR_WORKSPACE_ID: "w1",
			}).currentLocation(),
		).toEqual({
			runtime: "herdr",
			paneId: "w1:p2",
			tabId: "w1:t2",
			workspaceId: "w1",
		})
		expect(
			createHerdrRuntimeProvider(fs, "herdr", {
				HERDR_PANE_ID: "w1:p2",
			}).currentLocation(),
		).toBeNull()
	})
})

describe("Herdr event subscription", () => {
	let tempDir: string
	beforeEach(async () => {
		tempDir = await createTempDir()
	})
	afterEach(async () => {
		await cleanupTempDir(tempDir)
	})

	const serve = (lines: readonly string[]) => {
		const path = join(tempDir, "herdr.sock")
		const requests: unknown[] = []
		const server = Bun.listen({
			unix: path,
			socket: {
				data(socket, data) {
					requests.push(JSON.parse(data.toString()))
					// Deliberately omit the trailing newline after the last event.
					socket.write(lines.join("\n"))
					socket.end()
				},
			},
		})
		return { path, requests, server }
	}

	const paneInfo = {
		agent: "opencode",
		agent_session: { agent: "opencode", kind: "id", value: "ses_a" },
		agent_status: "working",
		cwd: "/wb/tasks/alpha",
		focused: false,
		foreground_cwd: "/wb/tasks/alpha/code/agency",
		pane_id: "w2:p9",
		revision: 4,
		tab_id: "w2:t1",
		terminal_id: "term_1",
		workspace_id: "w2",
	}

	test("streams validated events from the socket API", async () => {
		const { path, requests, server } = serve([
			JSON.stringify({ id: "x", result: { type: "subscription_started" } }),
			JSON.stringify({
				event: "pane_agent_status_changed",
				data: {
					type: "pane_agent_status_changed",
					pane_id: "w1:p2",
					workspace_id: "w1",
					agent_status: "blocked",
				},
			}),
			JSON.stringify({
				event: "pane_closed",
				data: { type: "pane_closed", pane_id: "w1:p3", workspace_id: "w1" },
			}),
		])
		try {
			const { fs } = fakeFs(() => ok(""))
			const provider = createHerdrRuntimeProvider(fs, "herdr", {
				HERDR_SOCKET_PATH: path,
			})
			const events = await Effect.runPromise(
				Stream.runCollect(
					provider.subscribe([
						{ type: "pane.agent_status_changed", paneId: "w1:p2" },
						{ type: "pane.closed" },
					]),
				),
			)
			expect(requests).toEqual([
				{
					id: expect.any(String),
					method: "events.subscribe",
					params: {
						subscriptions: [
							{ type: "pane.agent_status_changed", pane_id: "w1:p2" },
							{ type: "pane.closed" },
						],
					},
				},
			])
			expect([...events]).toEqual([
				{
					type: "pane_agent_status_changed",
					paneId: "w1:p2",
					tabId: null,
					workspaceId: "w1",
					agentStatus: "blocked",
					pane: null,
					previousPaneId: null,
					data: expect.objectContaining({ pane_id: "w1:p2" }),
				},
				// The final, unterminated line is flushed when the socket closes.
				expect.objectContaining({
					type: "pane_closed",
					paneId: "w1:p3",
					agentStatus: null,
				}),
			])
		} finally {
			server.stop(true)
		}
	})

	test("reads the pane from nested event data and exposes moves", async () => {
		const { path, server } = serve([
			JSON.stringify({
				event: "pane_moved",
				data: {
					type: "pane_moved",
					pane: paneInfo,
					previous_pane_id: "w1:p2",
					previous_tab_id: "w1:t2",
					previous_workspace_id: "w1",
					closed_tab_id: "w1:t2",
					closed_workspace_id: null,
					created_tab: null,
					created_workspace: null,
				},
			}),
			JSON.stringify({
				event: "pane_updated",
				data: {
					type: "pane_updated",
					pane: { ...paneInfo, agent_status: "idle" },
				},
			}),
		])
		try {
			const { fs } = fakeFs(() => ok(""))
			const events = [
				...(await Effect.runPromise(
					Stream.runCollect(
						createHerdrRuntimeProvider(fs, "herdr", {
							HERDR_SOCKET_PATH: path,
						}).subscribe([{ type: "pane.moved" }, { type: "pane.updated" }]),
					),
				)),
			]
			expect(events[0]).toMatchObject({
				type: "pane_moved",
				paneId: "w2:p9",
				tabId: "w2:t1",
				workspaceId: "w2",
				agentStatus: "working",
				previousPaneId: "w1:p2",
				pane: {
					paneId: "w2:p9",
					agentSessionId: "ses_a",
					foregroundCwd: "/wb/tasks/alpha/code/agency",
				},
			})
			expect(events[1]).toMatchObject({
				type: "pane_updated",
				paneId: "w2:p9",
				agentStatus: "idle",
				previousPaneId: null,
			})
		} finally {
			server.stop(true)
		}
	})

	test("fails when the socket is unavailable", async () => {
		const { fs } = fakeFs(() => ok(""))
		const provider = createHerdrRuntimeProvider(fs, "herdr", {
			HERDR_SOCKET_PATH: join(tempDir, "missing.sock"),
		})
		const error = await Effect.runPromise(
			Effect.flip(
				Stream.runCollect(provider.subscribe([{ type: "pane.closed" }])),
			),
		)
		expect(error).toMatchObject({
			_tag: "RuntimeError",
			operation: "subscribe",
		})
	})
})

describe("RuntimeService", () => {
	test("detects Herdr from the inherited environment or the binary", async () => {
		const provider = (env: NodeJS.ProcessEnv, which: Result) => {
			const { fs, calls, timeouts } = fakeFs(() => which)
			return Effect.runPromise(
				Effect.flatMap(RuntimeService, (service) => service.provider(env)).pipe(
					Effect.provide(RuntimeService.layer),
					Effect.provide(Layer.succeed(FileSystemService, fs)),
				),
			).then((result) => ({ result, calls, timeouts }))
		}
		const inherited = await provider(
			{ HERDR_ENV: "1", HERDR_BIN_PATH: "/opt/herdr" },
			ok(""),
		)
		expect(inherited.result?.kind).toBe("herdr")
		expect(inherited.calls).toEqual([])
		const found = await provider({}, ok("/usr/local/bin/herdr"))
		expect(found.result?.kind).toBe("herdr")
		expect(found.calls).toEqual([["which", "herdr"]])
		expect(found.timeouts).toEqual([2_000])
		const absent = await provider({}, { exitCode: 1, stdout: "", stderr: "" })
		expect(absent.result).toBeNull()
	})
})
