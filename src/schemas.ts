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
}) {}

/**
 * Schema for agency configuration stored in ~/.config/agency/agency.json
 */
export class AgencyConfig extends Schema.Class<AgencyConfig>("AgencyConfig")({
	prBranch: Schema.String.pipe(Schema.annotations({ default: "%branch%--PR" })),
}) {}

/**
 * Schema for template metadata
 */
export class TemplateMetadata extends Schema.Class<TemplateMetadata>(
	"TemplateMetadata",
)({
	name: Schema.String,
	path: Schema.String,
	description: Schema.optional(Schema.String),
	files: Schema.Array(Schema.String),
	createdAt: Schema.optional(Schema.DateTimeUtc),
	updatedAt: Schema.optional(Schema.DateTimeUtc),
}) {}

/**
 * Parse and validate agency metadata from JSON
 */
export const parseAgencyMetadata = Schema.decode(AgencyMetadata)

/**
 * Encode agency metadata to JSON
 */
export const encodeAgencyMetadata = Schema.encode(AgencyMetadata)

/**
 * Parse and validate agency config from JSON
 */
export const parseAgencyConfig = Schema.decode(AgencyConfig)

/**
 * Encode agency config to JSON
 */
export const encodeAgencyConfig = Schema.encode(AgencyConfig)

/**
 * Parse and validate managed file from JSON
 */
export const parseManagedFile = Schema.decode(ManagedFile)

/**
 * Parse and validate template metadata from JSON
 */
export const parseTemplateMetadata = Schema.decode(TemplateMetadata)
