import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"

const USAGE_EVENT_VERSION = 2 as const
const DEFAULT_RETENTION_DAYS = 90

const INVOCATION_SOURCES = new Set(["human", "agent", "automation"])
const USAGE_EVENT_COLUMNS = new Set([
	"id",
	"event_version",
	"journey_id",
	"journey_sequence",
	"invocation_source",
	"is_test",
	"occurred_at",
	"agency_version",
	"command_path",
	"flag_names",
	"duration_ms",
	"outcome",
	"outcome_code",
	"exit_status",
	"vcs",
	"terminal_stage",
	"category",
])

export type UsageOutcomeCode =
	| "SUCCESS"
	| "NONZERO_EXIT"
	| "CLI_USAGE"
	| "WORKBASE_NOT_FOUND"
	| "WORKBASE_INVALID"
	| "VALIDATION_FAILED"
	| "CONFLICT"
	| "FILESYSTEM_ERROR"
	| "PROCESS_ERROR"
	| "COMMAND_FAILED"

export interface UsageEvent {
	readonly commandPath: string
	readonly flagNames: readonly string[]
	readonly durationMs: number
	readonly exitStatus: number
	readonly outcome: "success" | "failure"
	readonly outcomeCode: UsageOutcomeCode
	readonly vcs?: "git"
	readonly terminalStage?: string
	readonly category?: string
}

export const usageOutcomeCode = (error: unknown): UsageOutcomeCode => {
	const tag =
		typeof error === "object" &&
		error !== null &&
		"_tag" in error &&
		typeof error._tag === "string"
			? error._tag
			: error instanceof Error
				? error.name
				: undefined
	switch (tag) {
		case "CliUsageError":
			return "CLI_USAGE"
		case "WorkbaseNotFoundError":
			return "WORKBASE_NOT_FOUND"
		case "WorkbaseConfigError":
		case "WorkbaseRegistryError":
		case "FrontmatterParseError":
			return "WORKBASE_INVALID"
		case "ValidationFailedError":
			return "VALIDATION_FAILED"
		case "ClaimConflictError":
		case "ClaimOwnershipError":
		case "RevisionConflictError":
		case "ExecutionGuardError":
			return "CONFLICT"
		case "FileNotFoundError":
		case "FileSystemError":
			return "FILESYSTEM_ERROR"
		case "ProcessError":
			return "PROCESS_ERROR"
		default:
			return "COMMAND_FAILED"
	}
}

const stateDirectory = (env: NodeJS.ProcessEnv) =>
	env.XDG_STATE_HOME ?? join(env.HOME ?? ".", ".local", "state")

const usageDatabasePath = (env: NodeJS.ProcessEnv = process.env) =>
	env.AGENCY_USAGE_DB ?? join(stateDirectory(env), "agency", "usage.sqlite3")

const enabled = (env: NodeJS.ProcessEnv) =>
	!["1", "true", "yes"].includes((env.AGENCY_NO_USAGE_LOG ?? "").toLowerCase())

const retentionDays = (env: NodeJS.ProcessEnv) => {
	const value = Number.parseInt(env.AGENCY_USAGE_RETENTION_DAYS ?? "", 10)
	return Number.isSafeInteger(value) && value >= 0
		? value
		: DEFAULT_RETENTION_DAYS
}

const invocationSource = (env: NodeJS.ProcessEnv) => {
	const source = env.AGENCY_INVOCATION_SOURCE?.toLowerCase()
	if (source && INVOCATION_SOURCES.has(source)) return source
	return env.AGENCY_SESSION_ID ? "agent" : "human"
}

const isTestInvocation = (env: NodeJS.ProcessEnv) =>
	["1", "true", "yes"].includes((env.AGENCY_USAGE_TEST ?? "").toLowerCase())

const journeyId = (env: NodeJS.ProcessEnv) => {
	if (!env.AGENCY_SESSION_ID) return null
	return `sha256:${createHash("sha256").update(env.AGENCY_SESSION_ID).digest("hex")}`
}

const pruneExpiredEvents = (database: Database, env: NodeJS.ProcessEnv) => {
	database
		.query(
			"DELETE FROM usage_events WHERE datetime(occurred_at) < datetime('now', ?)",
		)
		.run(`-${retentionDays(env)} days`)
}

const openDatabase = async (env: NodeJS.ProcessEnv) => {
	const path = usageDatabasePath(env)
	await mkdir(dirname(path), { recursive: true, mode: 0o700 })
	const database = new Database(path, { create: true, strict: true })
	database.run("PRAGMA journal_mode = WAL")
	database.run("PRAGMA busy_timeout = 1000")
	const existingColumns = database
		.query("PRAGMA table_info(usage_events)")
		.all() as { name: string }[]
	if (
		existingColumns.length > 0 &&
		(existingColumns.length !== USAGE_EVENT_COLUMNS.size ||
			existingColumns.some(({ name }) => !USAGE_EVENT_COLUMNS.has(name)))
	) {
		// Version 1 could contain positional values. Do not preserve unsafe telemetry.
		database.run("DROP TABLE usage_events")
	}
	database.run(`
		CREATE TABLE IF NOT EXISTS usage_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			event_version INTEGER NOT NULL,
			journey_id TEXT,
			journey_sequence INTEGER,
			invocation_source TEXT NOT NULL,
			is_test INTEGER NOT NULL,
			occurred_at TEXT NOT NULL,
			agency_version TEXT NOT NULL,
			command_path TEXT NOT NULL,
			flag_names TEXT NOT NULL,
			duration_ms INTEGER NOT NULL,
			outcome TEXT NOT NULL,
			outcome_code TEXT NOT NULL,
			exit_status INTEGER NOT NULL,
			vcs TEXT,
			terminal_stage TEXT,
			category TEXT
		)
	`)
	database.run(
		"CREATE INDEX IF NOT EXISTS usage_events_journey ON usage_events(journey_id, journey_sequence)",
	)
	database.run(
		"CREATE INDEX IF NOT EXISTS usage_events_command ON usage_events(command_path, occurred_at)",
	)
	return database
}

export async function recordUsageEvent(
	event: UsageEvent,
	agencyVersion: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	if (!enabled(env)) return
	let database: Database | undefined
	try {
		database = await openDatabase(env)
		pruneExpiredEvents(database, env)
		const eventJourneyId = journeyId(env)
		database
			.query(`
					INSERT INTO usage_events (
						event_version, journey_id, journey_sequence,
						invocation_source, is_test, occurred_at,
						agency_version, command_path, flag_names, duration_ms,
						outcome, outcome_code, exit_status, vcs, terminal_stage, category
					) VALUES (
						?, ?,
						CASE WHEN ? IS NULL THEN NULL ELSE
							(SELECT COALESCE(MAX(journey_sequence), 0) + 1 FROM usage_events WHERE journey_id = ?)
						END,
						?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
					)
				`)
			.run(
				USAGE_EVENT_VERSION,
				eventJourneyId,
				eventJourneyId,
				eventJourneyId,
				invocationSource(env),
				isTestInvocation(env) ? 1 : 0,
				new Date().toISOString(),
				agencyVersion,
				event.commandPath,
				JSON.stringify([...new Set(event.flagNames)].sort()),
				Math.max(0, Math.round(event.durationMs)),
				event.outcome,
				event.outcomeCode,
				event.exitStatus,
				event.vcs ?? null,
				event.terminalStage ?? null,
				event.category ?? null,
			)
	} catch {
		// Usage logging must never affect command behavior.
	} finally {
		database?.close()
	}
}

export async function exportUsageEvents(
	env: NodeJS.ProcessEnv = process.env,
): Promise<readonly Record<string, unknown>[]> {
	if (!enabled(env)) return []
	let database: Database | undefined
	try {
		database = await openDatabase(env)
		pruneExpiredEvents(database, env)
		const rows = database
			.query(`
				SELECT event_version, journey_id, journey_sequence,
					invocation_source, is_test, occurred_at,
					agency_version, command_path, flag_names, duration_ms,
					outcome, outcome_code, exit_status, vcs, terminal_stage, category
				FROM usage_events ORDER BY occurred_at, id
			`)
			.all() as Record<string, string | number | null>[]
		return rows.map((row) => ({
			version: row.event_version,
			journeyId: row.journey_id,
			journeySequence: row.journey_sequence,
			invocationSource: row.invocation_source,
			isTest: row.is_test === 1,
			occurredAt: row.occurred_at,
			agencyVersion: row.agency_version,
			commandPath: row.command_path,
			flagNames: JSON.parse(String(row.flag_names)),
			durationMs: row.duration_ms,
			outcome: row.outcome,
			outcomeCode: row.outcome_code,
			exitStatus: row.exit_status,
			...(row.vcs == null ? {} : { vcs: row.vcs }),
			...(row.terminal_stage == null
				? {}
				: { terminalStage: row.terminal_stage }),
			...(row.category == null ? {} : { category: row.category }),
		}))
	} catch {
		return []
	} finally {
		database?.close()
	}
}
