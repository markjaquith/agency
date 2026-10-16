import { Context, Data, Effect, Layer, Option, Schema } from "effect"
import { join } from "node:path"
import { TriageAssessment } from "../triage-schema"
import { agencyStateDirectory } from "../workbase/state-directory"
import { FileSystemService } from "./FileSystemService"

const STATE_VERSION = 1 as const

/** One executed (or attempted) supervisor action, fed back into triage. */
const ActionLogEntry = Schema.Struct({
	version: Schema.Literal(STATE_VERSION),
	at: Schema.String,
	/** The supervised item key, or null for an action about no item. */
	key: Schema.NullOr(Schema.String),
	actionId: Schema.String,
	type: Schema.String,
	title: Schema.String,
	outcome: Schema.Literals(["succeeded", "failed", "cancelled"]),
	detail: Schema.NullOr(Schema.String),
})

/** Hide an item, or one of its actions, until a time. */
const Snooze = Schema.Struct({
	version: Schema.Literal(STATE_VERSION),
	at: Schema.String,
	key: Schema.String,
	/** One action, or null for the whole item. */
	actionId: Schema.NullOr(Schema.String),
	until: Schema.String,
	reason: Schema.NullOr(Schema.String),
})

/**
 * Hide an item, or one of its actions. With a fingerprint, the dismissal
 * lapses once the item's state changes.
 */
const Dismissal = Schema.Struct({
	version: Schema.Literal(STATE_VERSION),
	at: Schema.String,
	key: Schema.String,
	actionId: Schema.NullOr(Schema.String),
	fingerprint: Schema.NullOr(Schema.String),
	reason: Schema.NullOr(Schema.String),
})

export const TriageCacheEntry = Schema.Struct({
	key: Schema.String,
	/** The workbase root the item belongs to, or null for an unowned pane. */
	workbase: Schema.NullOr(Schema.String),
	fingerprint: Schema.String,
	evaluatedAt: Schema.String,
	assessment: TriageAssessment,
})

const TriageCache = Schema.Struct({
	version: Schema.Literal(STATE_VERSION),
	entries: Schema.Array(TriageCacheEntry),
})

const Snoozes = Schema.Array(Snooze)
const Dismissals = Schema.Array(Dismissal)

type ActionLogEntry = Schema.Schema.Type<typeof ActionLogEntry>
type Snooze = Schema.Schema.Type<typeof Snooze>
type Dismissal = Schema.Schema.Type<typeof Dismissal>
export type TriageCacheEntry = Schema.Schema.Type<typeof TriageCacheEntry>

type Without<T> = Omit<T, "version" | "at"> & { readonly at?: string }

const decodeLogLine = Schema.decodeUnknownOption(
	Schema.fromJsonString(ActionLogEntry),
)
const decodeCache = Schema.decodeUnknownOption(
	Schema.fromJsonString(TriageCache),
)
const decodeSnoozes = Schema.decodeUnknownOption(Schema.fromJsonString(Snoozes))
const decodeDismissals = Schema.decodeUnknownOption(
	Schema.fromJsonString(Dismissals),
)

interface Target {
	readonly key: string
	readonly actionId: string | null
}

const sameTarget = (a: Target, b: Target) =>
	a.key === b.key && a.actionId === b.actionId

const LOCK_STALE_MS = 30_000
const LOCK_TIMEOUT_MS = 10_000
const LOCK_RETRY_MS = 20
/** Compact the action log to its newest entries once it passes the limit. */
const ACTION_LOG_KEEP = 1000
const ACTION_LOG_LIMIT = 1200

class SupervisionStateLockError extends Data.TaggedError(
	"SupervisionStateLockError",
)<{ readonly path: string; readonly message: string }> {}

/**
 * Local supervision state: the triage result cache, the action log, snoozes,
 * and dismissals. It lives under $AGENCY_STATE_DIR/supervision, never in
 * TASK, PHASE, or EPIC documents. Unreadable state reads as empty. Every
 * read-modify-write holds an exclusive lock file, so concurrent triage runs
 * and the supervisor cannot lose each other's updates.
 */
export class SupervisionStateService extends Context.Service<SupervisionStateService>()(
	"SupervisionStateService",
	{
		make: Effect.sync(() => {
			const directory = (env: NodeJS.ProcessEnv = process.env) =>
				join(agencyStateDirectory(env), "supervision")
			const file = (name: string, env?: NodeJS.ProcessEnv) =>
				join(directory(env), name)

			const read = <A>(
				name: string,
				decode: (input: string) => Option.Option<A>,
				fallback: A,
				env?: NodeJS.ProcessEnv,
			) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const content = yield* fs
						.readFile(file(name, env))
						.pipe(Effect.orElseSucceed(() => null))
					if (content === null) return fallback
					return Option.getOrElse(decode(content), () => fallback)
				})

			const write = (name: string, data: unknown, env?: NodeJS.ProcessEnv) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					yield* fs.createDirectory(directory(env))
					yield* fs.writeFileAtomic(
						file(name, env),
						`${JSON.stringify(data, null, 2)}\n`,
					)
				})

			/** Run `use` while holding an exclusive lock on one state file. */
			const withLock = <A, E, R>(
				name: string,
				use: Effect.Effect<A, E, R>,
				env?: NodeJS.ProcessEnv,
			) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const path = file(`${name}.lock`, env)
					yield* fs.createDirectory(directory(env))
					const started = Date.now()
					const acquire = Effect.gen(function* () {
						while (!(yield* fs.createExclusive(path, `${process.pid}\n`))) {
							const modified = yield* fs.modifiedAt(path)
							if (modified !== null && Date.now() - modified > LOCK_STALE_MS) {
								yield* fs.deleteFile(path).pipe(Effect.ignore)
								continue
							}
							if (Date.now() - started > LOCK_TIMEOUT_MS)
								return yield* new SupervisionStateLockError({
									path,
									message: `Timed out waiting for the supervision state lock ${path}`,
								})
							yield* Effect.sleep(LOCK_RETRY_MS)
						}
					})
					return yield* Effect.acquireUseRelease(
						acquire,
						() => use,
						() => fs.deleteFile(path).pipe(Effect.ignore),
					)
				})

			const now = () => new Date().toISOString()

			const snoozes = (
				env?: NodeJS.ProcessEnv,
				at: Date = new Date(),
			): Effect.Effect<readonly Snooze[], never, FileSystemService> =>
				read("snoozes.json", decodeSnoozes, [], env).pipe(
					Effect.map((entries) =>
						entries.filter((entry) => Date.parse(entry.until) > at.getTime()),
					),
				)

			const dismissals = (env?: NodeJS.ProcessEnv) =>
				read("dismissals.json", decodeDismissals, [], env)

			const triageCache = (env?: NodeJS.ProcessEnv) =>
				read(
					"triage-cache.json",
					decodeCache,
					{ version: STATE_VERSION, entries: [] },
					env,
				).pipe(Effect.map((cache) => cache.entries))

			const updateSnoozes = (
				update: (entries: readonly Snooze[]) => readonly Snooze[],
				env?: NodeJS.ProcessEnv,
			) =>
				withLock(
					"snoozes",
					Effect.flatMap(snoozes(env), (active) =>
						write("snoozes.json", update(active), env),
					),
					env,
				)

			const updateDismissals = (
				update: (entries: readonly Dismissal[]) => readonly Dismissal[],
				env?: NodeJS.ProcessEnv,
			) =>
				withLock(
					"dismissals",
					Effect.flatMap(dismissals(env), (current) =>
						write("dismissals.json", update(current), env),
					),
					env,
				)

			const readActions = (env?: NodeJS.ProcessEnv) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const content = yield* fs
						.readFile(file("actions.jsonl", env))
						.pipe(Effect.orElseSucceed(() => ""))
					return content
						.split("\n")
						.flatMap((line) =>
							line.trim() ? Option.toArray(decodeLogLine(line)) : [],
						)
				})

			return {
				directory,

				/** Cached triage assessments, keyed by item. */
				triageCache,

				/**
				 * Replace the cache with `update(current)`, reading the current cache
				 * under the lock so concurrent runs merge rather than overwrite.
				 */
				updateTriageCache: (
					update: (
						entries: readonly TriageCacheEntry[],
					) => readonly TriageCacheEntry[],
					env?: NodeJS.ProcessEnv,
				) =>
					withLock(
						"triage-cache",
						Effect.flatMap(triageCache(env), (current) =>
							write(
								"triage-cache.json",
								{
									version: STATE_VERSION,
									entries: [...update(current)].sort((a, b) =>
										a.key.localeCompare(b.key),
									),
								},
								env,
							),
						),
						env,
					),

				appendAction: (
					entry: Without<ActionLogEntry>,
					env?: NodeJS.ProcessEnv,
				) =>
					withLock(
						"actions",
						Effect.gen(function* () {
							const fs = yield* FileSystemService
							const record: ActionLogEntry = {
								version: STATE_VERSION,
								...entry,
								at: entry.at ?? now(),
							}
							const path = file("actions.jsonl", env)
							yield* fs.appendFile(path, `${JSON.stringify(record)}\n`)
							const entries = yield* readActions(env)
							if (entries.length > ACTION_LOG_LIMIT)
								yield* fs.writeFileAtomic(
									path,
									entries
										.slice(-ACTION_LOG_KEEP)
										.map((item) => `${JSON.stringify(item)}\n`)
										.join(""),
								)
							return record
						}),
						env,
					),

				/** The most recent action log entries, oldest first. */
				actions: (
					options: { readonly limit?: number } = {},
					env?: NodeJS.ProcessEnv,
				) =>
					readActions(env).pipe(
						Effect.map((entries) =>
							options.limit === undefined
								? entries
								: entries.slice(-options.limit),
						),
					),

				/** Active snoozes; expired ones are ignored. */
				snoozes,

				snooze: (entry: Without<Snooze>, env?: NodeJS.ProcessEnv) => {
					const record: Snooze = {
						version: STATE_VERSION,
						...entry,
						at: entry.at ?? now(),
					}
					return updateSnoozes(
						(active) => [
							...active.filter((item) => !sameTarget(item, record)),
							record,
						],
						env,
					).pipe(Effect.as(record))
				},

				unsnooze: (target: Target, env?: NodeJS.ProcessEnv) =>
					updateSnoozes(
						(active) => active.filter((item) => !sameTarget(item, target)),
						env,
					),

				dismissals,

				dismiss: (entry: Without<Dismissal>, env?: NodeJS.ProcessEnv) => {
					const record: Dismissal = {
						version: STATE_VERSION,
						...entry,
						at: entry.at ?? now(),
					}
					return updateDismissals(
						(current) => [
							...current.filter((item) => !sameTarget(item, record)),
							record,
						],
						env,
					).pipe(Effect.as(record))
				},

				undismiss: (target: Target, env?: NodeJS.ProcessEnv) =>
					updateDismissals(
						(current) => current.filter((item) => !sameTarget(item, target)),
						env,
					),

				/** Drop dismissals for which `keep` returns false. */
				pruneDismissals: (
					keep: (dismissal: Dismissal) => boolean,
					env?: NodeJS.ProcessEnv,
				) => updateDismissals((current) => current.filter(keep), env),
			}
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
