import { Schema, Data, type Effect, type Stream } from "effect"

export const RuntimeKind = Schema.Literals(["herdr"])
export type RuntimeKind = Schema.Schema.Type<typeof RuntimeKind>

export const RuntimeAgentStatus = Schema.Literals([
	"idle",
	"working",
	"blocked",
	"done",
	"unknown",
])
export type RuntimeAgentStatus = Schema.Schema.Type<typeof RuntimeAgentStatus>

export const RuntimePane = Schema.Struct({
	paneId: Schema.String,
	tabId: Schema.String,
	workspaceId: Schema.String,
	agent: Schema.NullOr(Schema.String),
	agentSessionId: Schema.NullOr(Schema.String),
	agentStatus: RuntimeAgentStatus,
	cwd: Schema.NullOr(Schema.String),
	foregroundCwd: Schema.NullOr(Schema.String),
	terminalTitle: Schema.NullOr(Schema.String),
	focused: Schema.Boolean,
})
export type RuntimePane = Schema.Schema.Type<typeof RuntimePane>

interface RuntimeTab {
	readonly tabId: string
	readonly workspaceId: string
	readonly label: string | null
	readonly focused: boolean
}

interface RuntimeWorkspace {
	readonly workspaceId: string
	readonly label: string | null
	readonly focused: boolean
}

export interface RuntimeSnapshot {
	readonly runtime: RuntimeKind
	readonly workspaces: readonly RuntimeWorkspace[]
	readonly tabs: readonly RuntimeTab[]
	readonly panes: readonly RuntimePane[]
}

/** The runtime location of the current process, when it runs inside a runtime. */
export interface RuntimeLocation {
	readonly runtime: RuntimeKind
	readonly paneId: string
	readonly tabId: string | null
	readonly workspaceId: string | null
}

export type RuntimeSubscription =
	| { readonly type: "pane.agent_status_changed"; readonly paneId: string }
	| { readonly type: "pane.closed" }
	| { readonly type: "pane.created" }
	| { readonly type: "pane.moved" }
	| { readonly type: "pane.updated" }
	| { readonly type: "tab.closed" }
	| { readonly type: "workspace.closed" }

export interface RuntimeEvent {
	readonly type: string
	readonly paneId: string | null
	readonly tabId: string | null
	readonly workspaceId: string | null
	readonly agentStatus: RuntimeAgentStatus | null
	/** The full pane, for events that carry one (created, updated, moved). */
	readonly pane: RuntimePane | null
	/** The pane's ID before a move. */
	readonly previousPaneId: string | null
	readonly data: Readonly<Record<string, unknown>>
}

type RuntimeTarget = "pane" | "tab" | "workspace"

/** A command started in a new, unfocused tab. */
interface RuntimeLaunch {
	readonly workspaceId: string | null
	readonly cwd: string
	readonly label: string
	/** A shell command line run in the tab's root pane. */
	readonly command: string
	readonly env?: Readonly<Record<string, string>>
}

interface RuntimeLaunched {
	readonly tabId: string
	readonly paneId: string
}

export class RuntimeError extends Data.TaggedError("RuntimeError")<{
	readonly runtime: RuntimeKind
	readonly operation: string
	readonly code: string | null
	readonly message: string
	readonly cause?: unknown
}> {}

/**
 * A terminal runtime that hosts agent sessions. Absence of a runtime is a normal
 * state: RuntimeService returns no provider rather than failing.
 */
export interface RuntimeProvider {
	readonly kind: RuntimeKind
	readonly currentLocation: () => RuntimeLocation | null
	readonly snapshot: () => Effect.Effect<RuntimeSnapshot, RuntimeError>
	readonly readTranscript: (
		paneId: string,
		options?: { readonly lines?: number },
	) => Effect.Effect<string, RuntimeError>
	/** Resolves with the matching pane, or null when the timeout elapses. */
	readonly waitForAgentStatus: (
		paneId: string,
		statuses: readonly RuntimeAgentStatus[],
		options: { readonly timeoutMs: number },
	) => Effect.Effect<RuntimePane | null, RuntimeError>
	readonly subscribe: (
		subscriptions: readonly RuntimeSubscription[],
	) => Stream.Stream<RuntimeEvent, RuntimeError>
	readonly focus: (
		target: RuntimeTarget,
		id: string,
	) => Effect.Effect<void, RuntimeError>
	readonly close: (
		target: RuntimeTarget,
		id: string,
	) => Effect.Effect<void, RuntimeError>
	/**
	 * Submit a prompt to the agent in a pane. Fails with code `agent_blocked`
	 * when the agent waits at an approval or question dialog.
	 */
	readonly promptAgent: (
		paneId: string,
		prompt: string,
	) => Effect.Effect<void, RuntimeError>
	/** Run a command in a new tab without taking focus. */
	readonly launch: (
		launch: RuntimeLaunch,
	) => Effect.Effect<RuntimeLaunched, RuntimeError>
}

const DEFAULT_TRANSCRIPT_LINES = 200
const MAX_TRANSCRIPT_LINES = 2000

export const boundedTranscriptLines = (lines?: number) =>
	Math.min(
		MAX_TRANSCRIPT_LINES,
		Math.max(1, Math.floor(lines ?? DEFAULT_TRANSCRIPT_LINES)),
	)

/**
 * The Herdr pane hosting the current process, from Herdr's inherited
 * environment. Needs no binary or subprocess.
 */
export const currentHerdrLocation = (
	env: NodeJS.ProcessEnv = process.env,
): RuntimeLocation | null =>
	env.HERDR_ENV === "1" && env.HERDR_PANE_ID
		? {
				runtime: "herdr",
				paneId: env.HERDR_PANE_ID,
				tabId: env.HERDR_TAB_ID || null,
				workspaceId: env.HERDR_WORKSPACE_ID || null,
			}
		: null
