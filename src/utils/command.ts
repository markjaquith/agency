/**
 * Base options that all commands accept
 */
export interface BaseCommandOptions {
	readonly silent?: boolean
	readonly verbose?: boolean
	/**
	 * Working directory to use instead of process.cwd().
	 * Primarily used for testing to enable concurrent test execution.
	 */
	readonly cwd?: string
	/**
	 * Agency config directory to use instead of AGENCY_CONFIG_DIR env var.
	 * Primarily used for testing to enable concurrent test execution.
	 */
	readonly configDir?: string
}
