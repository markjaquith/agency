import { Effect, Context, Data } from "effect"

// Error types for Template operations
export class TemplateError extends Data.TaggedError("TemplateError")<{
	message: string
	cause?: unknown
}> {}

export class TemplateNotFoundError extends Data.TaggedError(
	"TemplateNotFoundError",
)<{
	template: string
}> {}

// Template Service interface
export class TemplateService extends Context.Tag("TemplateService")<
	TemplateService,
	{
		readonly getTemplateDir: (
			templateName: string,
		) => Effect.Effect<string, never>
		readonly templateExists: (
			templateName: string,
		) => Effect.Effect<boolean, TemplateError>
		readonly createTemplateDir: (
			templateName: string,
		) => Effect.Effect<void, TemplateError>
		readonly listTemplates: () => Effect.Effect<
			readonly string[],
			TemplateError
		>
		readonly getConfigDir: () => Effect.Effect<string, never>
	}
>() {}
