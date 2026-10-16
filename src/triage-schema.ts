import { Schema } from "effect"
import {
	AttentionSubject,
	AttentionWorkbaseRef,
	SupervisorAction,
} from "./attention-schema"
import { RuntimeKind } from "./workbase/runtime"

/** The locked triage response contract version, shipped with Agency. */
export const TRIAGE_VERSION = 1 as const

const TriageStatus = Schema.Literals([
	"needs_input",
	"blocked",
	"in_progress",
	"awaiting_review",
	"ready_to_merge",
	"complete",
	"idle",
	"unknown",
])

const AssessmentFields = {
	status: TriageStatus,
	/** One line describing where the item stands. */
	summary: Schema.String,
	/** The open question the item's agent is waiting on, if any. */
	question: Schema.NullOr(Schema.String),
	/** Recommended actions, best first. */
	actions: Schema.Array(SupervisorAction),
}

/** The locked response contract the triage agent must emit. */
export const TriageResponse = Schema.Struct({
	version: Schema.Literal(TRIAGE_VERSION),
	items: Schema.Array(
		Schema.Struct({
			/** The item key from the snapshot, which references its subject. */
			key: Schema.String,
			...AssessmentFields,
		}),
	),
})

/** The triage agent's validated judgment about one item. */
export const TriageAssessment = Schema.Struct({
	...AssessmentFields,
	/**
	 * Actions the model wrote itself rather than copying from a deterministic
	 * signal. Treat them as LLM-sourced: never read-only, and confirm first.
	 */
	modelActionIds: Schema.Array(Schema.String),
})

const TriageItemSource = Schema.Literals([
	/** Evaluated in this run. */
	"fresh",
	/** Unchanged since its cached evaluation. */
	"cached",
	/** Changed, but re-evaluation failed; the assessment is from an earlier state. */
	"stale",
	/** Changed, re-evaluation failed, and no earlier assessment exists. */
	"failed",
])

export const TriageReportItem = Schema.Struct({
	key: Schema.String,
	subject: AttentionSubject,
	fingerprint: Schema.String,
	source: TriageItemSource,
	evaluatedAt: Schema.NullOr(Schema.String),
	/** Actions snoozed or dismissed by the supervisor are removed. */
	assessment: Schema.NullOr(TriageAssessment),
	/** Set when the whole item is snoozed or dismissed. */
	suppressed: Schema.NullOr(Schema.Literals(["snoozed", "dismissed"])),
	error: Schema.NullOr(Schema.String),
})

export const TriageFailure = Schema.Struct({
	workbase: Schema.NullOr(AttentionWorkbaseRef),
	keys: Schema.Array(Schema.String),
	kind: Schema.Literals(["runner", "invalid_response"]),
	message: Schema.String,
	/** Validation errors from the final attempt. */
	errors: Schema.Array(Schema.String),
	attempts: Schema.Number,
	sessionId: Schema.NullOr(Schema.String),
})

export const TriageReport = Schema.Struct({
	version: Schema.Literal(TRIAGE_VERSION),
	generatedAt: Schema.String,
	runtime: Schema.Struct({
		provider: Schema.NullOr(RuntimeKind),
		available: Schema.Boolean,
		error: Schema.NullOr(Schema.String),
	}),
	workbases: Schema.Array(
		Schema.Struct({
			...AttentionWorkbaseRef.fields,
			available: Schema.Boolean,
			error: Schema.NullOr(Schema.String),
		}),
	),
	items: Schema.Array(TriageReportItem),
	failures: Schema.Array(TriageFailure),
	summary: Schema.Struct({
		total: Schema.Number,
		fresh: Schema.Number,
		cached: Schema.Number,
		stale: Schema.Number,
		failed: Schema.Number,
	}),
})

export type TriageAssessment = Schema.Schema.Type<typeof TriageAssessment>
export type TriageResponse = Schema.Schema.Type<typeof TriageResponse>
export type TriageReportItem = Schema.Schema.Type<typeof TriageReportItem>
export type TriageFailure = Schema.Schema.Type<typeof TriageFailure>
export type TriageReport = Schema.Schema.Type<typeof TriageReport>
