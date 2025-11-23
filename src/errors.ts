import { Data } from "effect"

/**
 * Error thrown when a command requires the repository to be initialized
 * but agency.template is not set in git config
 */
export class RepositoryNotInitializedError extends Data.TaggedError(
	"RepositoryNotInitializedError",
)<{
	readonly message: string
}> {
	constructor(
		message: string = "Repository not initialized. Run 'agency init' first to select a template.",
	) {
		super({ message })
	}
}
