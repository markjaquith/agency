import { Schema } from "@effect/schema"

/**
 * Schema for managed files in the agency system
 */
export class ManagedFile extends Schema.Class<ManagedFile>("ManagedFile")({
	name: Schema.String,
	defaultContent: Schema.optional(Schema.String),
}) {}

/**
 * Schema for agency metadata stored in agency.json
 */
export class AgencyMetadata extends Schema.Class<AgencyMetadata>(
	"AgencyMetadata",
)({
	version: Schema.Literal(1),
	injectedFiles: Schema.Array(Schema.String),
	baseBranch: Schema.optional(Schema.String),
	template: Schema.String,
	createdAt: Schema.DateTimeUtc,
	emitBranch: Schema.optional(Schema.String),
}) {}

/**
 * Schema for agency configuration stored in ~/.config/agency/agency.json
 */
export class AgencyConfig extends Schema.Class<AgencyConfig>("AgencyConfig")({
	sourceBranchPattern: Schema.String.pipe(
		Schema.annotations({ default: "agency/%branch%" }),
	),
	emitBranch: Schema.String.pipe(Schema.annotations({ default: "%branch%" })),
}) {}
