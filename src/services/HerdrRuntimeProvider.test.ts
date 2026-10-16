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
	const fs = {
		runCommand: (args: readonly string[]) => {
			calls.push(args)
			return Effect.succeed(respond(args))
		},
	} as unknown as FileSystemService["Service"]
	return { fs, calls }
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
		const { fs, calls } = fakeFs(() =>
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
		const { fs, calls } = fakeFs(() => ok("line one\nline two"))
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

	test("streams validated events from the socket API", async () => {
		const path = join(tempDir, "herdr.sock")
		const requests: unknown[] = []
		const server = Bun.listen({
			unix: path,
			socket: {
				data(socket, data) {
					requests.push(JSON.parse(data.toString()))
					socket.write(
						[
							JSON.stringify({
								id: "x",
								result: { type: "subscription_started" },
							}),
							JSON.stringify({
								event: "pane.agent_status_changed",
								data: {
									type: "pane_agent_status_changed",
									pane_id: "w1:p2",
									workspace_id: "w1",
									agent_status: "blocked",
								},
							}),
							JSON.stringify({
								event: "pane.closed",
								data: { pane_id: "w1:p3" },
							}),
							"",
						].join("\n"),
					)
					socket.end()
				},
			},
		})
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
					type: "pane.agent_status_changed",
					paneId: "w1:p2",
					tabId: null,
					workspaceId: "w1",
					agentStatus: "blocked",
					data: expect.objectContaining({ pane_id: "w1:p2" }),
				},
				expect.objectContaining({
					type: "pane.closed",
					paneId: "w1:p3",
					agentStatus: null,
				}),
			])
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
			const { fs, calls } = fakeFs(() => which)
			return Effect.runPromise(
				Effect.flatMap(RuntimeService, (service) => service.provider(env)).pipe(
					Effect.provide(RuntimeService.layer),
					Effect.provide(Layer.succeed(FileSystemService, fs)),
				),
			).then((result) => ({ result, calls }))
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
		const absent = await provider({}, { exitCode: 1, stdout: "", stderr: "" })
		expect(absent.result).toBeNull()
	})
})
