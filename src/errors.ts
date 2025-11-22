/**
 * Base error class that automatically sets error name based on class name
 */
export class NamedError extends Error {
	constructor(message: string) {
		super(message)
		this.name = this.constructor.name
	}
}

/**
 * Error thrown when a command requires the repository to be initialized
 * but agency.template is not set in git config
 */
export class RepositoryNotInitializedError extends NamedError {
	constructor() {
		super(
			"Repository not initialized. Run 'agency init' first to select a template.",
		)
	}
}
