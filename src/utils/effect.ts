import { Effect, Layer } from "effect"
import { GitService } from "../services/GitService"

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

/**
 * Create logging functions based on options
 */
export function createLoggers(options: {
	readonly silent?: boolean
	readonly verbose?: boolean
}) {
	const { silent = false, verbose = false } = options
	return {
		log: silent ? () => {} : console.log,
		verboseLog: verbose && !silent ? console.log : () => {},
	}
}

/**
 * Ensure we're in a git repository and return the git root
 */
export function ensureGitRepo() {
	return Effect.gen(function* () {
		const git = yield* GitService

		const isGitRepo = yield* git.isInsideGitRepo(process.cwd())
		if (!isGitRepo) {
			return yield* Effect.fail(
				new Error(
					"Not in a git repository. Please run this command inside a git repo.",
				),
			)
		}

		return yield* git.getGitRoot(process.cwd())
	})
}
