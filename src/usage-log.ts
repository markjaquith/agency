import { Database } from "bun:sqlite"
import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"

const USAGE_EVENT_VERSION = 1 as const
const DEFAULT_RETENTION_DAYS = 90

export interface UsageEvent {
	readonly commandPath: string
	readonly flagNames: readonly string[]
	readonly durationMs: number
	readonly exitStatus: number
	readonly outcome: "success" | "failure"
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

const openDatabase = async (env: NodeJS.ProcessEnv) => {
	const path = usageDatabasePath(env)
	await mkdir(dirname(path), { recursive: true, mode: 0o700 })
	const database = new Database(path, { create: true, strict: true })
	database.run("PRAGMA journal_mode = WAL")
	database.run("PRAGMA busy_timeout = 1000")
	database.run(`
		CREATE TABLE IF NOT EXISTS usage_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			event_version INTEGER NOT NULL,
			session_id TEXT NOT NULL,
			session_sequence INTEGER NOT NULL,
			occurred_at TEXT NOT NULL,
			agency_version TEXT NOT NULL,
			command_path TEXT NOT NULL,
			flag_names TEXT NOT NULL,
			duration_ms INTEGER NOT NULL,
			outcome TEXT NOT NULL,
			exit_status INTEGER NOT NULL
		)
	`)
	database.run(
		"CREATE INDEX IF NOT EXISTS usage_events_session ON usage_events(session_id, session_sequence)",
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
		const sessionId = env.AGENCY_SESSION_ID || `process-${process.pid}`
		database
			.query(`
					INSERT INTO usage_events (
						event_version, session_id, session_sequence, occurred_at,
						agency_version, command_path, flag_names, duration_ms,
						outcome, exit_status
					) VALUES (
						?, ?,
						(SELECT COALESCE(MAX(session_sequence), 0) + 1 FROM usage_events WHERE session_id = ?),
						?, ?, ?, ?, ?, ?, ?
					)
				`)
			.run(
				USAGE_EVENT_VERSION,
				sessionId,
				sessionId,
				new Date().toISOString(),
				agencyVersion,
				event.commandPath,
				JSON.stringify([...new Set(event.flagNames)].sort()),
				Math.max(0, Math.round(event.durationMs)),
				event.outcome,
				event.exitStatus,
			)
		if (Math.random() < 0.01) {
			const days = retentionDays(env)
			database
				.query(
					"DELETE FROM usage_events WHERE occurred_at < datetime('now', ?)",
				)
				.run(`-${days} days`)
		}
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
		const rows = database
			.query(`
				SELECT event_version, session_id, session_sequence, occurred_at,
					agency_version, command_path, flag_names, duration_ms,
					outcome, exit_status
				FROM usage_events ORDER BY occurred_at, id
			`)
			.all() as Record<string, string | number>[]
		return rows.map((row) => ({
			version: row.event_version,
			sessionId: row.session_id,
			sessionSequence: row.session_sequence,
			occurredAt: row.occurred_at,
			agencyVersion: row.agency_version,
			commandPath: row.command_path,
			flagNames: JSON.parse(String(row.flag_names)),
			durationMs: row.duration_ms,
			outcome: row.outcome,
			exitStatus: row.exit_status,
		}))
	} catch {
		return []
	} finally {
		database?.close()
	}
}
