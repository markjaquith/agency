import { Context, Effect, Layer, Option, Schema } from "effect"
import { join } from "node:path"
import { TriageAssessment } from "../triage-schema"
import { agencyStateDirectory } from "../workbase/state-directory"
import { FileSystemService } from "./FileSystemService"

const STATE_VERSION = 1 as const

/** One executed (or attempted) supervisor action, fed back into triage. */
export const ActionLogEntry = Schema.Struct({
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
export const Snooze = Schema.Struct({
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
export const Dismissal = Schema.Struct({
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

export type ActionLogEntry = Schema.Schema.Type<typeof ActionLogEntry>
export type Snooze = Schema.Schema.Type<typeof Snooze>
export type Dismissal = Schema.Schema.Type<typeof Dismissal>
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

const sameTarget = (
	a: { readonly key: string; readonly actionId: string | null },
	b: { readonly key: string; readonly actionId: string | null },
) => a.key === b.key && a.actionId === b.actionId

/**
 * Local supervision state: the triage result cache, the action log, snoozes,
 * and dismissals. It lives under $AGENCY_STATE_DIR/supervision, never in
 * TASK, PHASE, or EPIC documents. Unreadable state reads as empty.
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
					const path = file(name, env)
					const temporary = `${path}.${process.pid}.tmp`
					yield* fs.createDirectory(directory(env))
					yield* fs.writeJSON(temporary, data)
					yield* fs
						.moveDirectory(temporary, path)
						.pipe(
							Effect.tapError(() =>
								fs.deleteFile(temporary).pipe(Effect.ignore),
							),
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

			return {
				directory,

				/** Cached triage assessments, keyed by item. */
				triageCache: (env?: NodeJS.ProcessEnv) =>
					read(
						"triage-cache.json",
						decodeCache,
						{ version: STATE_VERSION, entries: [] },
						env,
					).pipe(Effect.map((cache) => cache.entries)),

				writeTriageCache: (
					entries: readonly TriageCacheEntry[],
					env?: NodeJS.ProcessEnv,
				) =>
					write(
						"triage-cache.json",
						{
							version: STATE_VERSION,
							entries: [...entries].sort((a, b) => a.key.localeCompare(b.key)),
						},
						env,
					),

				appendAction: (
					entry: Without<ActionLogEntry>,
					env?: NodeJS.ProcessEnv,
				) =>
					Effect.gen(function* () {
						const fs = yield* FileSystemService
						const record: ActionLogEntry = {
							version: STATE_VERSION,
							...entry,
							at: entry.at ?? now(),
						}
						yield* fs.createDirectory(directory(env))
						yield* fs.appendFile(
							file("actions.jsonl", env),
							`${JSON.stringify(record)}\n`,
						)
						return record
					}),

				/** The most recent action log entries, oldest first. */
				actions: (
					options: { readonly limit?: number } = {},
					env?: NodeJS.ProcessEnv,
				) =>
					Effect.gen(function* () {
						const fs = yield* FileSystemService
						const content = yield* fs
							.readFile(file("actions.jsonl", env))
							.pipe(Effect.orElseSucceed(() => ""))
						const entries = content
							.split("\n")
							.flatMap((line) =>
								line.trim() ? Option.toArray(decodeLogLine(line)) : [],
							)
						return options.limit === undefined
							? entries
							: entries.slice(-options.limit)
					}),

				/** Active snoozes; expired ones are ignored. */
				snoozes,

				snooze: (entry: Without<Snooze>, env?: NodeJS.ProcessEnv) =>
					Effect.gen(function* () {
						const record: Snooze = {
							version: STATE_VERSION,
							...entry,
							at: entry.at ?? now(),
						}
						const active = yield* snoozes(env)
						yield* write(
							"snoozes.json",
							[...active.filter((item) => !sameTarget(item, record)), record],
							env,
						)
						return record
					}),

				unsnooze: (
					target: { readonly key: string; readonly actionId: string | null },
					env?: NodeJS.ProcessEnv,
				) =>
					Effect.gen(function* () {
						const active = yield* snoozes(env)
						yield* write(
							"snoozes.json",
							active.filter((item) => !sameTarget(item, target)),
							env,
						)
					}),

				dismissals,

				dismiss: (entry: Without<Dismissal>, env?: NodeJS.ProcessEnv) =>
					Effect.gen(function* () {
						const record: Dismissal = {
							version: STATE_VERSION,
							...entry,
							at: entry.at ?? now(),
						}
						const current = yield* dismissals(env)
						yield* write(
							"dismissals.json",
							[...current.filter((item) => !sameTarget(item, record)), record],
							env,
						)
						return record
					}),

				undismiss: (
					target: { readonly key: string; readonly actionId: string | null },
					env?: NodeJS.ProcessEnv,
				) =>
					Effect.gen(function* () {
						const current = yield* dismissals(env)
						yield* write(
							"dismissals.json",
							current.filter((item) => !sameTarget(item, target)),
							env,
						)
					}),
			}
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
