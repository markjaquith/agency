import { Effect, Layer } from "effect"

/**
 * Helper to run an Effect program with services and proper error handling
 */
export async function runEffect<A, E>(
	effect: Effect.Effect<A, E, any>,
	services: readonly Layer.Layer<any, never, never>[],
): Promise<A> {
	let program: Effect.Effect<A, E | Error, never> = effect as any

	// Provide all services
	for (const service of services) {
		program = Effect.provide(program, service) as any
	}

	// Add defect catching
	const programWithCatch = Effect.catchAllDefect(program, (defect) =>
		Effect.fail(defect instanceof Error ? defect : new Error(String(defect))),
	) as Effect.Effect<A, E | Error, never>

	return await Effect.runPromise(programWithCatch)
}
