/**
 * Base options that all commands accept
 */
export interface BaseCommandOptions {
	readonly silent?: boolean
	readonly verbose?: boolean
	readonly json?: boolean
	/**
	 * Working directory to use instead of process.cwd().
	 * Primarily used for testing to enable concurrent test execution.
	 */
	readonly cwd?: string
}
