import { Effect, pipe } from "effect"
import { ConfigService } from "./services/ConfigService"
import { ConfigServiceLive } from "./services/ConfigServiceLive"
import { AgencyConfig } from "./schemas"

// Re-export the AgencyConfig type for backward compatibility
export { AgencyConfig }

/**
 * Helper function to run an Effect with the ConfigService
 * This provides backward compatibility with the existing async functions
 */
const runWithConfigService = <A, E>(
	effect: Effect.Effect<A, E, ConfigService>,
) => Effect.runPromise(pipe(effect, Effect.provide(ConfigServiceLive)))

const DEFAULT_CONFIG: AgencyConfig = new AgencyConfig({
	prBranch: "%branch%--PR",
})

export function getConfigDir(): string {
	// Allow override for testing
	if (process.env.AGENCY_CONFIG_DIR) {
		return process.env.AGENCY_CONFIG_DIR
	}
	const { homedir } = require("node:os")
	const { join } = require("node:path")
	return join(homedir(), ".config", "agency")
}

export async function loadConfig(configPath?: string): Promise<AgencyConfig> {
	try {
		return await runWithConfigService(
			Effect.gen(function* () {
				const config = yield* ConfigService
				return yield* config.loadConfig(configPath)
			}),
		)
	} catch (error) {
		// If there's an error, return default config
		console.error(
			`Warning: Could not load config. Using defaults. Error: ${error}`,
		)
		return DEFAULT_CONFIG
	}
}

export function getDefaultConfig(): AgencyConfig {
	return DEFAULT_CONFIG
}
