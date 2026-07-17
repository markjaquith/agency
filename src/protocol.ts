import { Schema } from "@effect/schema"

export const PROTOCOL_VERSION = 1 as const

const ErrorFields = Schema.Record({
	key: Schema.String,
	value: Schema.Unknown,
})

export const SuccessEnvelope = Schema.Struct({
	version: Schema.Literal(PROTOCOL_VERSION),
	ok: Schema.Literal(true),
	result: Schema.Unknown,
})

export const ErrorDetail = Schema.Struct({
	code: Schema.String,
	message: Schema.String,
	fields: ErrorFields,
	retryable: Schema.Boolean,
	remediation: Schema.optional(Schema.String),
})

export const ErrorEnvelope = Schema.Struct({
	version: Schema.Literal(PROTOCOL_VERSION),
	ok: Schema.Literal(false),
	error: ErrorDetail,
})

export const AgencyEnvelope = Schema.Union(SuccessEnvelope, ErrorEnvelope)

export type SuccessEnvelope = Schema.Schema.Type<typeof SuccessEnvelope>
export type ErrorEnvelope = Schema.Schema.Type<typeof ErrorEnvelope>
export type AgencyEnvelope = Schema.Schema.Type<typeof AgencyEnvelope>

interface ErrorMetadata {
	readonly code: string
	readonly retryable: boolean
	readonly remediation?: string
}

const errorMetadata: Readonly<Record<string, ErrorMetadata>> = {
	CliUsageError: {
		code: "CLI_USAGE",
		retryable: false,
		remediation: "Correct the arguments using the usage value in error.fields.",
	},
	WorkbaseNotFoundError: {
		code: "WORKBASE_NOT_FOUND",
		retryable: false,
		remediation:
			"Run the command from an Agency workbase or provide an explicit workbase path.",
	},
	WorkbaseConfigError: {
		code: "WORKBASE_CONFIG_INVALID",
		retryable: false,
		remediation: "Correct the workbase configuration and retry the command.",
	},
	WorkbaseRegistryError: {
		code: "WORKBASE_REGISTRY_ERROR",
		retryable: false,
		remediation: "Correct the registered workbase entry and retry the command.",
	},
	FileNotFoundError: {
		code: "FILE_NOT_FOUND",
		retryable: false,
		remediation: "Restore the required file or correct the supplied path.",
	},
	FileSystemError: { code: "FILESYSTEM_ERROR", retryable: false },
	FrontmatterParseError: {
		code: "FRONTMATTER_INVALID",
		retryable: false,
		remediation: "Correct the document frontmatter and retry the command.",
	},
	ValidationFailedError: {
		code: "VALIDATION_FAILED",
		retryable: false,
		remediation: "Resolve the validation issues in error.fields and retry.",
	},
	RepositoryError: { code: "REPOSITORY_ERROR", retryable: false },
	EpicError: { code: "EPIC_ERROR", retryable: false },
	TaskError: { code: "TASK_ERROR", retryable: false },
	PhaseError: { code: "PHASE_ERROR", retryable: false },
	ClaimError: { code: "CLAIM_ERROR", retryable: false },
	ClaimConflictError: {
		code: "CLAIM_CONFLICT",
		retryable: true,
		remediation: "Inspect the current ownership details before retrying.",
	},
	RevisionConflictError: {
		code: "REVISION_CONFLICT",
		retryable: true,
		remediation: "Read the current document revision and retry intentionally.",
	},
	ClaimOwnershipError: {
		code: "CLAIM_OWNERSHIP",
		retryable: false,
		remediation: "Use the session that owns the claim.",
	},
	ArchiveError: { code: "ARCHIVE_ERROR", retryable: false },
	WorktreeError: { code: "WORKTREE_ERROR", retryable: false },
	PullRequestError: { code: "PULL_REQUEST_ERROR", retryable: false },
	ContextError: {
		code: "CONTEXT_ERROR",
		retryable: false,
		remediation:
			"Run the command from an Agency entity or provide a valid target.",
	},
	GraphError: {
		code: "GRAPH_ERROR",
		retryable: false,
		remediation: "Correct the workbase graph data or filters and retry.",
	},
	SyncError: {
		code: "SYNC_ERROR",
		retryable: false,
		remediation: "Resolve workbase validation errors before reconciling.",
	},
	ProcessError: { code: "PROCESS_ERROR", retryable: true },
	ProtocolOutputError: {
		code: "PROTOCOL_OUTPUT_ERROR",
		retryable: false,
		remediation: "Report this Agency protocol violation.",
	},
}

class ProtocolOutputError extends Error {
	readonly _tag = "ProtocolOutputError"
}

let resultCollector: ((value: unknown) => void) | undefined

const parseCommandResult = (value: unknown): unknown => {
	if (typeof value !== "string") return value
	try {
		return JSON.parse(value)
	} catch {
		return value
	}
}

export const emitCommandResult = (value: unknown): void => {
	if (resultCollector) {
		resultCollector(parseCommandResult(value))
		return
	}
	console.log(value)
}

export const collectCommandResult = async (
	run: () => Promise<void>,
): Promise<unknown> => {
	if (resultCollector) {
		throw new ProtocolOutputError(
			"A machine result collector is already active.",
		)
	}

	let emitted = false
	let result: unknown = null
	const originalLog = console.log
	resultCollector = (value) => {
		if (emitted) {
			throw new ProtocolOutputError(
				"A machine command emitted more than one result.",
			)
		}
		emitted = true
		result = value
	}
	console.log = (...values) => {
		resultCollector?.(
			parseCommandResult(values.length === 1 ? values[0] : values.join(" ")),
		)
	}

	try {
		await run()
		return result
	} finally {
		console.log = originalLog
		resultCollector = undefined
	}
}

const errorTag = (error: unknown): string | undefined => {
	if (typeof error !== "object" || error === null) return undefined
	if ("_tag" in error && typeof error._tag === "string") return error._tag
	if (error instanceof Error && error.name !== "Error") return error.name
	return undefined
}

const errorMessage = (error: unknown): string => {
	if (
		typeof error === "object" &&
		error !== null &&
		"message" in error &&
		typeof error.message === "string"
	) {
		return error.message
	}
	return String(error)
}

const errorFields = (error: unknown): Record<string, unknown> => {
	if (typeof error !== "object" || error === null) return {}
	return Object.fromEntries(
		Object.entries(error).filter(
			([key, value]) =>
				!key.startsWith("_") &&
				key !== "name" &&
				key !== "message" &&
				key !== "cause" &&
				value !== undefined,
		),
	)
}

export const successEnvelope = (result: unknown): SuccessEnvelope => ({
	version: PROTOCOL_VERSION,
	ok: true,
	result: result === undefined ? null : result,
})

export const errorEnvelope = (error: unknown): ErrorEnvelope => {
	const metadata = errorMetadata[errorTag(error) ?? ""] ?? {
		code: "COMMAND_FAILED",
		retryable: false,
	}
	return {
		version: PROTOCOL_VERSION,
		ok: false,
		error: {
			...metadata,
			message: errorMessage(error),
			fields: errorFields(error),
		},
	}
}

export const writeEnvelope = (envelope: AgencyEnvelope): void => {
	process.stdout.write(`${JSON.stringify(envelope)}\n`)
}
