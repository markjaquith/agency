import { Effect, pipe } from "effect"
import { PromptService } from "../services/PromptService"
import { PromptServiceLive } from "../services/PromptServiceLive"

/**
 * Helper function to run an Effect with the PromptService
 * This provides backward compatibility with the existing async functions
 */
const runWithPromptService = <A, E>(
	effect: Effect.Effect<A, E, PromptService>,
) => Effect.runPromise(pipe(effect, Effect.provide(PromptServiceLive)))

/**
 * Prompt the user for input with optional default value
 */
export async function prompt(
	question: string,
	defaultValue?: string,
): Promise<string> {
	return await runWithPromptService(
		Effect.gen(function* () {
			const promptService = yield* PromptService
			return yield* promptService.prompt(question, defaultValue)
		}),
	)
}

/**
 * Sanitize a template name to be filesystem-safe
 */
export function sanitizeTemplateName(name: string): string {
	// Replace problematic characters with hyphens
	return name
		.replace(/[^a-zA-Z0-9_-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.toLowerCase()
}

/**
 * Prompt for base branch selection with smart defaults
 */
export async function promptForBaseBranch(
	suggestions: string[],
): Promise<string> {
	return await runWithPromptService(
		Effect.gen(function* () {
			const promptService = yield* PromptService
			return yield* promptService.promptForSelection(
				"\nAvailable base branch options:",
				suggestions,
			)
		}),
	)
}
