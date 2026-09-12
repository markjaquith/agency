import { Schema } from "@effect/schema"
import { GraphReadiness } from "./graph-schema"
import { WorkStatus } from "./workbase/schemas"

const Argv = Schema.Array(Schema.String)
const Action = Schema.Struct({
	id: Schema.String,
	label: Schema.optional(Schema.String),
	available: Schema.Boolean,
	blockedReason: Schema.optional(Schema.NullOr(Schema.String)),
	inputs: Schema.optional(
		Schema.Array(
			Schema.Struct({
				id: Schema.String,
				label: Schema.String,
				required: Schema.Boolean,
				default: Schema.optional(Schema.String),
				choices: Schema.optional(Argv),
				slugFrom: Schema.optional(Schema.String),
				defaultTemplate: Schema.optional(Schema.String),
				omitWhen: Schema.optional(Schema.String),
			}),
		),
	),
	command: Schema.optional(Schema.NullOr(Argv)),
	commandTemplate: Schema.optional(Argv),
	followUpCommands: Schema.optional(Schema.Array(Argv)),
	nextActions: Schema.optional(
		Schema.Array(
			Schema.Struct({
				id: Schema.String,
				requiresSelection: Schema.Literal(true),
				commandTemplate: Argv,
			}),
		),
	),
})
const Kind = Schema.Literal("epic", "task", "phase")

export const ActDiscovery = Schema.Struct({
	workbase: Schema.Struct({
		root: Schema.String,
		repositories: Argv,
		actions: Schema.Array(Action),
	}),
	currentWork: Schema.Array(
		Schema.Struct({
			kind: Kind,
			key: Schema.String,
			description: Schema.optional(Schema.String),
			repositories: Argv,
			readiness: GraphReadiness,
		}),
	),
	targets: Schema.Array(
		Schema.Struct({
			kind: Kind,
			id: Schema.String,
			key: Schema.String,
			status: WorkStatus,
			readiness: GraphReadiness,
			revision: Schema.String,
			actions: Schema.Array(Action),
			blockedActions: Schema.Array(Action),
		}),
	),
})
