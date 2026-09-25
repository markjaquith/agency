import { Schema } from "@effect/schema"
import { GraphReadiness } from "./graph-schema"
import { WorkStatus } from "./workbase/schemas"

const Argv = Schema.Array(Schema.String)
const Action = Schema.Struct({
	id: Schema.String,
	label: Schema.optional(Schema.String),
	description: Schema.String,
	icon: Schema.String,
	color: Schema.String,
	available: Schema.Boolean,
	blockedReason: Schema.optional(Schema.NullOr(Schema.String)),
	inputs: Schema.optional(
		Schema.Array(
			Schema.Struct({
				id: Schema.String,
				label: Schema.String,
				required: Schema.Boolean,
				multiline: Schema.optional(Schema.Boolean),
				option: Schema.optional(Schema.String),
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
const EntityFields = {
	kind: Kind,
	id: Schema.String,
	key: Schema.String,
	status: WorkStatus,
	description: Schema.optional(Schema.String),
	repo: Schema.optional(Schema.String),
	repositories: Argv,
	readiness: GraphReadiness,
	revision: Schema.String,
}

export const ActDiscovery = Schema.Struct({
	creationDefaults: Schema.Struct({
		branch: Schema.Union(
			Schema.Struct({
				configured: Schema.Literal(true),
				guidance: Schema.String,
			}),
			Schema.Struct({
				configured: Schema.Literal(false),
				task: Schema.String,
				phase: Schema.String,
			}),
		),
	}),
	workbase: Schema.Struct({
		root: Schema.String,
		repositories: Argv,
		actions: Schema.Array(Action),
	}),
	currentWork: Schema.Array(Schema.Struct(EntityFields)),
	targets: Schema.Array(
		Schema.Struct({
			...EntityFields,
			actions: Schema.Array(Action),
			blockedActions: Schema.Array(Action),
		}),
	),
})
