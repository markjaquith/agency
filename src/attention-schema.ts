import { Schema } from "effect"
import { TicketStatusCategory } from "./tickets/provider"
import { RuntimeAgentStatus, RuntimeKind } from "./workbase/runtime"
import { WorkStatus } from "./workbase/schemas"

export const ACTION_VERSION = 1 as const
export const ATTENTION_VERSION = 1 as const

const Argv = Schema.Array(Schema.String)

export const AttentionWorkbaseRef = Schema.Struct({
	id: Schema.NullOr(Schema.String),
	name: Schema.NullOr(Schema.String),
	root: Schema.String,
})

export const AttentionItemRef = Schema.Struct({
	/** The execution unit, or null for a multi-phase task as a whole. */
	unit: Schema.NullOr(Schema.String),
	kind: Schema.Literals(["task", "phase"]),
	taskId: Schema.String,
	phaseId: Schema.optional(Schema.String),
	path: Schema.String,
	archived: Schema.Boolean,
})

export const AttentionRuntimeRef = Schema.Struct({
	runtime: RuntimeKind,
	paneId: Schema.String,
	tabId: Schema.NullOr(Schema.String),
	workspaceId: Schema.NullOr(Schema.String),
	agent: Schema.NullOr(Schema.String),
	agentSessionId: Schema.NullOr(Schema.String),
})

export const AttentionSubject = Schema.Struct({
	workbase: Schema.NullOr(AttentionWorkbaseRef),
	item: Schema.NullOr(AttentionItemRef),
	runtime: Schema.Array(AttentionRuntimeRef),
	pullRequest: Schema.NullOr(Schema.Struct({ url: Schema.String })),
	ticket: Schema.NullOr(
		Schema.Struct({ url: Schema.String, key: Schema.NullOr(Schema.String) }),
	),
})

const PullRequestState = Schema.Literals(["open", "closed", "merged"])

/** A state fact that must still hold when an action is executed. */
export const ActionPrecondition = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("document_revision"),
		path: Schema.String,
		sha256: Schema.String,
	}),
	Schema.Struct({
		kind: Schema.Literal("item_status"),
		unit: Schema.String,
		statuses: Schema.Array(WorkStatus),
	}),
	Schema.Struct({
		kind: Schema.Literal("item_archived"),
		unit: Schema.String,
		archived: Schema.Boolean,
	}),
	/**
	 * The pane must still exist with this identity. Pane IDs are reused, so the
	 * tab, working directory, and session must also match, and the agent status
	 * must be one of `agentStatuses`.
	 */
	Schema.Struct({
		kind: Schema.Literal("pane_matches"),
		runtime: RuntimeKind,
		paneId: Schema.String,
		tabId: Schema.String,
		cwd: Schema.NullOr(Schema.String),
		agentSessionId: Schema.NullOr(Schema.String),
		agentStatuses: Schema.Array(RuntimeAgentStatus),
	}),
	/** The tab's agent panes must be exactly this set. */
	Schema.Struct({
		kind: Schema.Literal("tab_agent_panes"),
		runtime: RuntimeKind,
		tabId: Schema.String,
		paneIds: Schema.Array(Schema.String),
	}),
	Schema.Struct({
		kind: Schema.Literal("pull_request_state"),
		url: Schema.String,
		states: Schema.Array(PullRequestState),
	}),
	/** The pull request head must still be this commit. */
	Schema.Struct({
		kind: Schema.Literal("pull_request_head"),
		url: Schema.String,
		sha: Schema.String,
	}),
	Schema.Struct({
		kind: Schema.Literal("ticket_status_category"),
		url: Schema.String,
		statusCategories: Schema.Array(TicketStatusCategory),
	}),
	Schema.Struct({
		kind: Schema.Literal("path_exists"),
		path: Schema.String,
		exists: Schema.Boolean,
	}),
])

export const ActionRisk = Schema.Literals([
	"read-only",
	"reversible",
	"destructive",
])

const ActionFields = {
	version: Schema.Literal(ACTION_VERSION),
	id: Schema.String,
	title: Schema.String,
	rationale: Schema.String,
	risk: ActionRisk,
	subject: AttentionSubject,
	preconditions: Schema.Array(ActionPrecondition),
}

const ActInput = Schema.Struct({
	id: Schema.String,
	label: Schema.String,
	required: Schema.Boolean,
	multiline: Schema.optional(Schema.Boolean),
	option: Schema.optional(Schema.String),
})

const AgencyPayloadFields = {
	/**
	 * An `agency act` action ID. Executors re-resolve the argv at execution time
	 * with `agency act --action <actionId> [--task <task> [--phase <phase>]]
	 * --json` from `cwd`; `command`/`commandTemplate` show the argv as discovered.
	 */
	actionId: Schema.String,
	/** The `agency act` item selector, or null for a workbase-level action. */
	selector: Schema.NullOr(
		Schema.Struct({
			task: Schema.String,
			phase: Schema.optional(Schema.String),
		}),
	),
	inputs: Schema.Array(ActInput),
	/** Input values by input ID, for a filled-in `commandTemplate`. */
	values: Schema.Record(Schema.String, Schema.String),
	/** The workbase root to run the command from. */
	cwd: Schema.String,
	/** After success, bind the resulting execution unit to this pane. */
	bindRuntime: Schema.NullOr(AttentionRuntimeRef),
}

const AgencyActionPayload = Schema.Union([
	Schema.Struct({
		...AgencyPayloadFields,
		command: Argv,
		commandTemplate: Schema.Null,
	}),
	Schema.Struct({
		...AgencyPayloadFields,
		command: Schema.Null,
		commandTemplate: Argv,
	}),
])

export const SupervisorAction = Schema.Union([
	Schema.Struct({
		...ActionFields,
		type: Schema.Literal("agency"),
		payload: AgencyActionPayload,
	}),
	Schema.Struct({
		...ActionFields,
		type: Schema.Literal("runtime"),
		payload: Schema.Struct({
			runtime: RuntimeKind,
			operation: Schema.Literals(["focus", "close"]),
			target: Schema.Literals(["pane", "tab", "workspace"]),
			id: Schema.String,
		}),
	}),
	Schema.Struct({
		...ActionFields,
		type: Schema.Literal("command"),
		payload: Schema.Struct({
			argv: Argv,
			cwd: Schema.NullOr(Schema.String),
		}),
	}),
	Schema.Struct({
		...ActionFields,
		type: Schema.Literal("prompt_agent"),
		payload: Schema.Struct({
			runtime: RuntimeKind,
			paneId: Schema.String,
			agentSessionId: Schema.NullOr(Schema.String),
			prompt: Schema.String,
		}),
	}),
	Schema.Struct({
		...ActionFields,
		type: Schema.Literal("delegate"),
		payload: Schema.Struct({
			unit: Schema.String,
			instructions: Schema.String,
			via: Schema.Literals(["prompt_bound_agent", "kickoff"]),
		}),
	}),
	Schema.Struct({
		...ActionFields,
		type: Schema.Literal("open_url"),
		payload: Schema.Struct({ url: Schema.String }),
	}),
])

export const AttentionSignalKind = Schema.Literals([
	"complete_session_open",
	"ticket_status_mismatch",
	"pr_merged_item_open",
	"pr_ready_to_merge",
	"claim_without_session",
	"duplicate_session",
	"session_cwd_missing",
	"agent_waiting",
	"unmanaged_session",
])

export const AttentionEvidence = Schema.Struct({
	source: Schema.Literals([
		"agency",
		"pull_request",
		"ticket",
		"runtime",
		"filesystem",
	]),
	label: Schema.String,
	value: Schema.Union([
		Schema.String,
		Schema.Number,
		Schema.Boolean,
		Schema.Null,
	]),
	/** The execution unit the fact describes, when a signal spans several. */
	unit: Schema.optional(Schema.String),
	phaseId: Schema.optional(Schema.String),
	/** The pane the fact describes, when a signal spans several. */
	paneId: Schema.optional(Schema.String),
})

export const AttentionSignal = Schema.Struct({
	id: Schema.String,
	kind: AttentionSignalKind,
	title: Schema.String,
	subject: AttentionSubject,
	evidence: Schema.Array(AttentionEvidence),
	actions: Schema.Array(SupervisorAction),
})

export const AttentionReport = Schema.Struct({
	version: Schema.Literal(ATTENTION_VERSION),
	generatedAt: Schema.String,
	runtime: Schema.Struct({
		provider: Schema.NullOr(RuntimeKind),
		available: Schema.Boolean,
		error: Schema.NullOr(Schema.String),
	}),
	workbases: Schema.Array(
		Schema.Struct({
			id: Schema.NullOr(Schema.String),
			name: Schema.NullOr(Schema.String),
			root: Schema.String,
			source: Schema.Literals(["registered", "current", "runtime"]),
			available: Schema.Boolean,
			error: Schema.NullOr(Schema.String),
		}),
	),
	signals: Schema.Array(AttentionSignal),
	summary: Schema.Struct({
		total: Schema.Number,
		kinds: Schema.Record(Schema.String, Schema.Number),
	}),
})

export type AttentionWorkbaseRef = Schema.Schema.Type<
	typeof AttentionWorkbaseRef
>
export type AttentionItemRef = Schema.Schema.Type<typeof AttentionItemRef>
export type AttentionRuntimeRef = Schema.Schema.Type<typeof AttentionRuntimeRef>
export type AttentionSubject = Schema.Schema.Type<typeof AttentionSubject>
export type ActionPrecondition = Schema.Schema.Type<typeof ActionPrecondition>
export type ActionRisk = Schema.Schema.Type<typeof ActionRisk>
export type SupervisorAction = Schema.Schema.Type<typeof SupervisorAction>
export type AttentionSignalKind = Schema.Schema.Type<typeof AttentionSignalKind>
export type AttentionEvidence = Schema.Schema.Type<typeof AttentionEvidence>
export type AttentionSignal = Schema.Schema.Type<typeof AttentionSignal>
export type AttentionReport = Schema.Schema.Type<typeof AttentionReport>
