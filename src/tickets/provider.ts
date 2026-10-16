import { Data, Effect, Result, Schema } from "effect"
import { FileSystemService } from "../services/FileSystemService"

export const TicketStatusCategory = Schema.Literals([
	"todo",
	"in_progress",
	"done",
])
export type TicketStatusCategory = Schema.Schema.Type<
	typeof TicketStatusCategory
>

export const TicketRecord = Schema.Union([
	Schema.Struct({ url: Schema.Null, state: Schema.Literal("none") }),
	Schema.Struct({
		url: Schema.String,
		state: Schema.Literal("unsupported"),
		reason: Schema.String,
	}),
	Schema.Struct({
		url: Schema.String,
		state: Schema.Literal("unavailable"),
		provider: Schema.String,
		key: Schema.String,
		reason: Schema.String,
	}),
	Schema.Struct({
		url: Schema.String,
		state: Schema.Literal("available"),
		provider: Schema.String,
		key: Schema.String,
		status: Schema.String,
		statusCategory: TicketStatusCategory,
		summary: Schema.String,
		resolution: Schema.NullOr(Schema.String),
	}),
])
export type TicketRecord = Schema.Schema.Type<typeof TicketRecord>

export interface TicketReference {
	readonly provider: string
	readonly key: string
	readonly url: string
}

interface TicketSnapshot {
	readonly key: string
	readonly url: string
	readonly status: string
	readonly statusCategory: TicketStatusCategory
	readonly summary: string
	readonly resolution: string | null
}

export interface TicketTransition {
	readonly id: string
	readonly name: string
	readonly toStatus: string
	readonly toStatusCategory: TicketStatusCategory
}

export type TicketTransitions =
	| {
			readonly supported: true
			readonly transitions: readonly TicketTransition[]
	  }
	| { readonly supported: false; readonly reason: string }

export class TicketUnavailableError extends Data.TaggedError(
	"TicketUnavailableError",
)<{
	readonly provider: string
	readonly message: string
}> {}

/**
 * A read-only adapter for one external ticket system. `resolve` is pure and
 * claims a URL; the remaining operations query the provider's CLI.
 */
export interface TicketProvider {
	readonly id: string
	readonly resolve: (url: string) => TicketReference | null
	readonly read: (
		reference: TicketReference,
	) => Effect.Effect<TicketSnapshot, TicketUnavailableError, FileSystemService>
	readonly transitions: (
		reference: TicketReference,
	) => Effect.Effect<
		TicketTransitions,
		TicketUnavailableError,
		FileSystemService
	>
}

const COMMAND_TIMEOUT_MS = 15_000

export const parseUrl = (url: string) => {
	try {
		return new URL(url)
	} catch {
		return null
	}
}

/** Run a provider CLI and decode its JSON output at the boundary. */
export const runJsonCommand = <S extends Schema.Decoder<unknown>>(
	provider: string,
	argv: readonly string[],
	schema: S,
) =>
	Effect.gen(function* () {
		const fs = yield* FileSystemService
		const result = yield* fs
			.runCommand(argv, { captureOutput: true, timeoutMs: COMMAND_TIMEOUT_MS })
			.pipe(
				Effect.mapError(
					(error) =>
						new TicketUnavailableError({
							provider,
							message: `Could not run '${argv[0]}': ${error.cause instanceof Error ? error.cause.message : error.message}`,
						}),
				),
			)
		if (result.exitCode !== 0) {
			return yield* new TicketUnavailableError({
				provider,
				message:
					result.stderr.trim() ||
					result.stdout.trim() ||
					`'${argv.join(" ")}' exited with code ${result.exitCode}`,
			})
		}
		const json = yield* Effect.try({
			try: () => JSON.parse(result.stdout) as unknown,
			catch: () =>
				new TicketUnavailableError({
					provider,
					message: `'${argv[0]}' returned invalid JSON`,
				}),
		})
		const decoded = Schema.decodeUnknownResult(schema, { errors: "all" })(json)
		if (Result.isFailure(decoded)) {
			return yield* new TicketUnavailableError({
				provider,
				message: `'${argv[0]}' returned an unexpected response:\n${decoded.failure.message}`,
			})
		}
		return decoded.success as S["Type"]
	})
