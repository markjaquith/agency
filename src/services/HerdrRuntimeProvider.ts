import { Cause, Effect, Option, Queue, Schema, Stream } from "effect"
import { homedir } from "node:os"
import { join } from "node:path"
import type { FileSystemService } from "./FileSystemService"
import {
	boundedTranscriptLines,
	currentHerdrLocation,
	RuntimeAgentStatus,
	RuntimeError,
	type RuntimeEvent,
	type RuntimePane,
	type RuntimeProvider,
	type RuntimeSnapshot,
	type RuntimeSubscription,
} from "../workbase/runtime"

const OptionalString = Schema.optional(Schema.NullOr(Schema.String))
const OptionalBoolean = Schema.optional(Schema.NullOr(Schema.Boolean))

const HerdrAgentSession = Schema.Struct({
	value: Schema.String,
})

const HerdrPane = Schema.Struct({
	pane_id: Schema.String,
	tab_id: Schema.String,
	workspace_id: Schema.String,
	agent: OptionalString,
	agent_session: Schema.optional(Schema.NullOr(HerdrAgentSession)),
	agent_status: OptionalString,
	cwd: OptionalString,
	foreground_cwd: OptionalString,
	terminal_title_stripped: OptionalString,
	terminal_title: OptionalString,
	focused: OptionalBoolean,
})

const HerdrTab = Schema.Struct({
	tab_id: Schema.String,
	workspace_id: Schema.String,
	label: OptionalString,
	focused: OptionalBoolean,
})

const HerdrWorkspace = Schema.Struct({
	workspace_id: Schema.String,
	label: OptionalString,
	focused: OptionalBoolean,
})

const HerdrSnapshot = Schema.Struct({
	workspaces: Schema.Array(HerdrWorkspace),
	tabs: Schema.Array(HerdrTab),
	panes: Schema.Array(HerdrPane),
})

const HerdrError = Schema.Struct({
	error: Schema.Struct({ code: Schema.String, message: Schema.String }),
})

const SnapshotResponse = Schema.Struct({
	result: Schema.Struct({ snapshot: HerdrSnapshot }),
})

const AgentResponse = Schema.Struct({
	result: Schema.Struct({ agent: HerdrPane }),
})

const SubscriptionEvent = Schema.Struct({
	event: Schema.String,
	data: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})

type HerdrPane = typeof HerdrPane.Type

const agentStatus = (value: string | null | undefined) =>
	Schema.is(RuntimeAgentStatus)(value) ? value : "unknown"

const normalizePane = (pane: HerdrPane): RuntimePane => ({
	paneId: pane.pane_id,
	tabId: pane.tab_id,
	workspaceId: pane.workspace_id,
	agent: pane.agent ?? null,
	agentSessionId: pane.agent_session?.value ?? null,
	agentStatus: agentStatus(pane.agent_status),
	cwd: pane.cwd ?? null,
	foregroundCwd: pane.foreground_cwd ?? null,
	terminalTitle: pane.terminal_title_stripped ?? pane.terminal_title ?? null,
	focused: pane.focused ?? false,
})

const parseJson = (text: string): unknown => {
	try {
		return JSON.parse(text)
	} catch {
		return undefined
	}
}

const failure = (operation: string, output: string, fallback: string) => {
	const parsed = Schema.decodeUnknownOption(HerdrError)(parseJson(output))
	return new RuntimeError({
		runtime: "herdr",
		operation,
		code: Option.isSome(parsed) ? parsed.value.error.code : null,
		message: Option.isSome(parsed) ? parsed.value.error.message : fallback,
	})
}

const decode = <S extends Schema.Decoder<unknown>>(
	schema: S,
	operation: string,
	output: string,
): Effect.Effect<S["Type"], RuntimeError> =>
	Schema.decodeUnknownEffect(schema)(parseJson(output)).pipe(
		Effect.mapError(
			(error) =>
				new RuntimeError({
					runtime: "herdr",
					operation,
					code: "invalid_response",
					message: `Herdr returned an unexpected ${operation} response`,
					cause: error,
				}),
		),
	)

const subscriptionRequest = (subscription: RuntimeSubscription) =>
	"paneId" in subscription
		? { type: subscription.type, pane_id: subscription.paneId }
		: { type: subscription.type }

const stringField = (data: Readonly<Record<string, unknown>>, key: string) =>
	typeof data[key] === "string" ? (data[key] as string) : null

const decodePane = Schema.decodeUnknownOption(HerdrPane)

const normalizeEvent = (event: typeof SubscriptionEvent.Type): RuntimeEvent => {
	const data = event.data ?? {}
	// pane_created, pane_updated, and pane_moved nest the pane under data.pane.
	const nested = decodePane(data.pane)
	const pane = Option.isSome(nested) ? normalizePane(nested.value) : null
	const status = stringField(data, "agent_status")
	return {
		type: event.event,
		paneId: pane?.paneId ?? stringField(data, "pane_id"),
		tabId: pane?.tabId ?? stringField(data, "tab_id"),
		workspaceId: pane?.workspaceId ?? stringField(data, "workspace_id"),
		agentStatus:
			pane?.agentStatus ?? (status === null ? null : agentStatus(status)),
		pane,
		previousPaneId: stringField(data, "previous_pane_id"),
		data,
	}
}

const SHORT_TIMEOUT_MS = 5_000

export const createHerdrRuntimeProvider = (
	fs: FileSystemService["Service"],
	binary: string,
	env: NodeJS.ProcessEnv = process.env,
): RuntimeProvider => {
	const run = (
		operation: string,
		args: readonly string[],
		timeoutMs = SHORT_TIMEOUT_MS,
	) =>
		fs.runCommand([binary, ...args], { captureOutput: true, timeoutMs }).pipe(
			Effect.mapError(
				(error) =>
					new RuntimeError({
						runtime: "herdr",
						operation,
						code: null,
						message: `Herdr ${operation} failed`,
						cause: error,
					}),
			),
		)

	return {
		kind: "herdr",
		currentLocation: () => currentHerdrLocation(env),

		snapshot: () =>
			Effect.gen(function* () {
				const result = yield* run("snapshot", ["api", "snapshot"])
				if (result.exitCode !== 0) {
					return yield* failure(
						"snapshot",
						result.stdout,
						result.stderr || "Herdr snapshot failed",
					)
				}
				const { snapshot } = (yield* decode(
					SnapshotResponse,
					"snapshot",
					result.stdout,
				)).result
				return {
					runtime: "herdr",
					workspaces: snapshot.workspaces.map((workspace) => ({
						workspaceId: workspace.workspace_id,
						label: workspace.label ?? null,
						focused: workspace.focused ?? false,
					})),
					tabs: snapshot.tabs.map((tab) => ({
						tabId: tab.tab_id,
						workspaceId: tab.workspace_id,
						label: tab.label ?? null,
						focused: tab.focused ?? false,
					})),
					panes: snapshot.panes.map(normalizePane),
				} satisfies RuntimeSnapshot
			}),

		readTranscript: (paneId, options) =>
			Effect.gen(function* () {
				const result = yield* run("pane read", [
					"pane",
					"read",
					paneId,
					"--source",
					"recent-unwrapped",
					"--lines",
					String(boundedTranscriptLines(options?.lines)),
				])
				if (result.exitCode !== 0) {
					return yield* failure(
						"pane read",
						result.stdout,
						result.stderr || `Unable to read pane ${paneId}`,
					)
				}
				return result.stdout
			}),

		waitForAgentStatus: (paneId, statuses, options) =>
			Effect.gen(function* () {
				const result = yield* run(
					"agent wait",
					[
						"agent",
						"wait",
						paneId,
						...statuses.flatMap((status) => ["--until", status]),
						"--timeout",
						String(Math.max(0, Math.floor(options.timeoutMs))),
					],
					options.timeoutMs + 30_000,
				)
				if (result.exitCode !== 0) {
					const error = failure(
						"agent wait",
						result.stdout,
						result.stderr || `Unable to wait for pane ${paneId}`,
					)
					if (error.code === "timeout") return null
					return yield* error
				}
				const response = yield* decode(
					AgentResponse,
					"agent wait",
					result.stdout,
				)
				return normalizePane(response.result.agent)
			}),

		subscribe: (subscriptions) =>
			Stream.callback<RuntimeEvent, RuntimeError>((queue) =>
				Effect.acquireRelease(
					Effect.sync(() => {
						const path =
							env.HERDR_SOCKET_PATH ??
							join(env.HOME ?? homedir(), ".config", "herdr", "herdr.sock")
						const decoder = new TextDecoder()
						const state = {
							buffer: "",
							closed: false,
							socket: undefined as { end(): void } | undefined,
						}
						const fail = (
							code: string | null,
							message: string,
							cause?: unknown,
						) =>
							Queue.failCauseUnsafe(
								queue,
								Cause.fail(
									new RuntimeError({
										runtime: "herdr",
										operation: "subscribe",
										code,
										message,
										cause,
									}),
								),
							)
						const handleLine = (line: string) => {
							if (!line.trim()) return
							const value = parseJson(line)
							const error = Schema.decodeUnknownOption(HerdrError)(value)
							if (Option.isSome(error)) {
								fail(error.value.error.code, error.value.error.message)
								return
							}
							const event = Schema.decodeUnknownOption(SubscriptionEvent)(value)
							if (Option.isSome(event)) {
								Queue.offerUnsafe(queue, normalizeEvent(event.value))
							}
						}
						const connect = () =>
							Bun.connect({
								unix: path,
								socket: {
									open(connection) {
										connection.write(
											`${JSON.stringify({
												id: `agency:subscribe:${process.pid}:${Date.now()}`,
												method: "events.subscribe",
												params: {
													subscriptions: subscriptions.map(subscriptionRequest),
												},
											})}\n`,
										)
									},
									data(_connection, chunk) {
										state.buffer += decoder.decode(chunk, { stream: true })
										let newline = state.buffer.indexOf("\n")
										while (newline >= 0) {
											handleLine(state.buffer.slice(0, newline))
											state.buffer = state.buffer.slice(newline + 1)
											newline = state.buffer.indexOf("\n")
										}
									},
									close() {
										if (state.closed) return
										state.buffer += decoder.decode()
										handleLine(state.buffer)
										state.buffer = ""
										Queue.endUnsafe(queue)
									},
									error(_connection, error) {
										fail(null, "Herdr subscription failed", error)
									},
								},
							})
						let connecting: ReturnType<typeof connect>
						try {
							connecting = connect()
						} catch (error) {
							fail(null, `Unable to connect to Herdr at ${path}`, error)
							return state
						}
						connecting.then(
							(connection) => {
								state.socket = connection
								if (state.closed) connection.end()
							},
							(error) =>
								fail(null, `Unable to connect to Herdr at ${path}`, error),
						)
						return state
					}),
					(state) =>
						Effect.sync(() => {
							state.closed = true
							state.socket?.end()
						}),
				),
			),
	}
}
