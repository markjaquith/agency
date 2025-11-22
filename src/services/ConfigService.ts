import { Effect, Context, Data } from "effect"
import { AgencyConfig } from "../schemas"

// Error types for Config operations
export class ConfigError extends Data.TaggedError("ConfigError")<{
	message: string
	cause?: unknown
}> {}

export class ConfigReadError extends Data.TaggedError("ConfigReadError")<{
	path: string
	cause?: unknown
}> {}

export class ConfigWriteError extends Data.TaggedError("ConfigWriteError")<{
	path: string
	cause?: unknown
}> {}

// Config Service interface
export class ConfigService extends Context.Tag("ConfigService")<
	ConfigService,
	{
		readonly getConfigDir: () => Effect.Effect<string, never>
		readonly getConfigPath: () => Effect.Effect<string, never>
		readonly loadConfig: (
			configPath?: string,
		) => Effect.Effect<AgencyConfig, ConfigError>
		readonly saveConfig: (
			config: AgencyConfig,
			configPath?: string,
		) => Effect.Effect<void, ConfigWriteError>
		readonly getDefaultConfig: () => Effect.Effect<AgencyConfig, never>
	}
>() {}
