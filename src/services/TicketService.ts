import { Clock, Context, Effect, Layer } from "effect"
import type { FileSystemService } from "./FileSystemService"
import {
	TicketUnavailableError,
	type TicketProvider,
	type TicketRecord,
	type TicketReference,
	type TicketTransitions,
} from "../tickets/provider"
import { TicketProviderRegistry } from "../tickets/registry"

const CACHE_TTL_MS = 30_000
const READ_CONCURRENCY = 8

interface CacheEntry {
	readonly expiresAt: number
	readonly record: Effect.Effect<TicketRecord, never, FileSystemService>
}

export class TicketService extends Context.Service<TicketService>()(
	"TicketService",
	{
		make: Effect.gen(function* () {
			const { providers } = yield* TicketProviderRegistry
			const cache = new Map<string, CacheEntry>()

			const resolve = (
				url: string,
			): { provider: TicketProvider; reference: TicketReference } | null => {
				for (const provider of providers) {
					const reference = provider.resolve(url)
					if (reference) return { provider, reference }
				}
				return null
			}

			const lookup = (
				url: string,
			): Effect.Effect<TicketRecord, never, FileSystemService> => {
				const resolved = resolve(url)
				if (!resolved) {
					return Effect.succeed({
						url,
						state: "unsupported",
						reason: "No ticket provider recognizes this URL",
					})
				}
				const { provider, reference } = resolved
				return provider.read(reference).pipe(
					Effect.map(
						(ticket): TicketRecord => ({
							url,
							state: "available",
							provider: provider.id,
							key: ticket.key,
							status: ticket.status,
							statusCategory: ticket.statusCategory,
							summary: ticket.summary,
							resolution: ticket.resolution,
						}),
					),
					Effect.catchIf(
						(error): error is TicketUnavailableError =>
							error instanceof TicketUnavailableError,
						(error) =>
							Effect.succeed<TicketRecord>({
								url,
								state: "unavailable",
								provider: provider.id,
								key: reference.key,
								reason: error.message,
							}),
					),
				)
			}

			const read = (url: string | null) =>
				Effect.gen(function* () {
					if (!url) return { url: null, state: "none" } as TicketRecord
					const now = yield* Clock.currentTimeMillis
					const cached = cache.get(url)
					if (cached && cached.expiresAt > now) return yield* cached.record
					const record = yield* Effect.cached(lookup(url))
					cache.set(url, { expiresAt: now + CACHE_TTL_MS, record })
					return yield* record
				})

			return {
				/** Read live ticket state; failures become explicit record states. */
				read,
				/** Read many tickets with bounded concurrency, keyed by URL. */
				readMany: (urls: Iterable<string | null | undefined>) =>
					Effect.gen(function* () {
						const unique = [
							...new Set(
								[...urls].filter((url): url is string => Boolean(url)),
							),
						]
						const records = yield* Effect.forEach(
							unique,
							(url) => read(url).pipe(Effect.map((record) => [url, record])),
							{ concurrency: READ_CONCURRENCY },
						)
						return new Map(records as [string, TicketRecord][])
					}),
				transitions: (
					url: string,
				): Effect.Effect<TicketTransitions, never, FileSystemService> => {
					const resolved = resolve(url)
					if (!resolved) {
						return Effect.succeed({
							supported: false,
							reason: "No ticket provider recognizes this URL",
						})
					}
					return resolved.provider.transitions(resolved.reference).pipe(
						Effect.catch((error) =>
							Effect.succeed<TicketTransitions>({
								supported: false,
								reason: error.message,
							}),
						),
					)
				},
			}
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(TicketProviderRegistry.layer),
	)
}
