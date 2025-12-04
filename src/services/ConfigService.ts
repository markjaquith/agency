import { Effect, Data } from "effect"
import { Schema } from "@effect/schema"
import { mkdir } from "node:fs/promises"
import { AgencyConfig } from "../schemas"
import { getAgencyConfigDir, getAgencyConfigPath } from "../utils/paths"

// Error types for Config operations
class ConfigError extends Data.TaggedError("ConfigError")<{
	message: string
	cause?: unknown
}> {}

class ConfigWriteError extends Data.TaggedError("ConfigWriteError")<{
	path: string
	cause?: unknown
}> {}

const DEFAULT_CONFIG: AgencyConfig = new AgencyConfig({
	sourceBranchPattern: "agency/%branch%",
	emitBranch: "%branch%",
})

// Config Service using Effect.Service pattern
export class ConfigService extends Effect.Service<ConfigService>()(
	"ConfigService",
	{
		sync: () => ({
			getConfigDir: () => Effect.sync(() => getAgencyConfigDir()),

			getConfigPath: () => Effect.sync(() => getAgencyConfigPath()),

			loadConfig: (configPath?: string) =>
				Effect.gen(function* () {
					const path =
						configPath || (yield* Effect.sync(() => getAgencyConfigPath()))

					// Check if file exists
					const file = Bun.file(path)
					const exists = yield* Effect.tryPromise({
						try: () => file.exists(),
						catch: () =>
							new ConfigError({
								message: `Failed to check if config exists at ${path}`,
							}),
					})

					if (!exists) {
						return DEFAULT_CONFIG
					}

					// Try to read and parse the config
					const data = yield* Effect.tryPromise({
						try: () => file.json(),
						catch: (error) =>
							new ConfigError({
								message: `Failed to read config file at ${path}`,
								cause: error,
							}),
					})

					// Parse with schema, but fall back to defaults on error
					const parsed = yield* Effect.try({
						try: () => Schema.decodeUnknownSync(AgencyConfig)(data),
						catch: (error) =>
							new ConfigError({
								message: `Invalid config format at ${path}`,
								cause: error,
							}),
					})

					// If we get here, parsing succeeded
					return parsed || DEFAULT_CONFIG
				}),

			saveConfig: (config: AgencyConfig, configPath?: string) =>
				Effect.gen(function* () {
					const path =
						configPath || (yield* Effect.sync(() => getAgencyConfigPath()))

					// Ensure the config directory exists
					const configDir = yield* Effect.sync(() => getAgencyConfigDir())

					yield* Effect.tryPromise({
						try: () => mkdir(configDir, { recursive: true }),
						catch: (error) =>
							new ConfigWriteError({
								path: configDir,
								cause: error,
							}),
					})

					// Encode and write the config
					const encoded = yield* Effect.try({
						try: () => Schema.encodeSync(AgencyConfig)(config),
						catch: (error) =>
							new ConfigWriteError({
								path,
								cause: error,
							}),
					})

					yield* Effect.tryPromise({
						try: () => Bun.write(path, JSON.stringify(encoded, null, 2) + "\n"),
						catch: (error) =>
							new ConfigWriteError({
								path,
								cause: error,
							}),
					})
				}),

			getDefaultConfig: () => Effect.succeed(DEFAULT_CONFIG),
		}),
	},
) {}
