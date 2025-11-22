import { Effect, Context, Data } from "effect"

// Error types for Prompt operations
export class PromptError extends Data.TaggedError("PromptError")<{
	message: string
	cause?: unknown
}> {}

// Prompt Service interface
export class PromptService extends Context.Tag("PromptService")<
	PromptService,
	{
		readonly prompt: (
			question: string,
			defaultValue?: string,
		) => Effect.Effect<string, PromptError>
		readonly promptForSelection: (
			message: string,
			options: readonly string[],
		) => Effect.Effect<string, PromptError>
		readonly sanitizeTemplateName: (
			name: string,
		) => Effect.Effect<string, never>
	}
>() {}
