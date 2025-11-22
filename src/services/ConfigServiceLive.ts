import { Effect, Layer } from "effect"
import { Schema } from "@effect/schema"
import { homedir } from "node:os"
import { join } from "node:path"
import { mkdir } from "node:fs/promises"
import { ConfigService, ConfigError, ConfigWriteError } from "./ConfigService"
import { AgencyConfig } from "../schemas"

const DEFAULT_CONFIG: AgencyConfig = new AgencyConfig({
	prBranch: "%branch%--PR",
})

export const ConfigServiceLive = Layer.succeed(
	ConfigService,
	ConfigService.of({
		getConfigDir: () =>
			Effect.sync(() => {
				// Allow override for testing
				if (process.env.AGENCY_CONFIG_DIR) {
					return process.env.AGENCY_CONFIG_DIR
				}
				return join(homedir(), ".config", "agency")
			}),

		getConfigPath: () =>
			Effect.sync(() => {
				// Allow override for testing
				if (process.env.AGENCY_CONFIG_PATH) {
					return process.env.AGENCY_CONFIG_PATH
				}
				const configDir =
					process.env.AGENCY_CONFIG_DIR || join(homedir(), ".config", "agency")
				return join(configDir, "agency.json")
			}),

		loadConfig: (configPath?: string) =>
			Effect.gen(function* () {
				const path =
					configPath ||
					(yield* Effect.sync(() => {
						if (process.env.AGENCY_CONFIG_PATH) {
							return process.env.AGENCY_CONFIG_PATH
						}
						const configDir =
							process.env.AGENCY_CONFIG_DIR ||
							join(homedir(), ".config", "agency")
						return join(configDir, "agency.json")
					}))

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
					configPath ||
					(yield* Effect.sync(() => {
						if (process.env.AGENCY_CONFIG_PATH) {
							return process.env.AGENCY_CONFIG_PATH
						}
						const configDir =
							process.env.AGENCY_CONFIG_DIR ||
							join(homedir(), ".config", "agency")
						return join(configDir, "agency.json")
					}))

				// Ensure the config directory exists
				const configDir = yield* Effect.sync(() => {
					if (process.env.AGENCY_CONFIG_DIR) {
						return process.env.AGENCY_CONFIG_DIR
					}
					return join(homedir(), ".config", "agency")
				})

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
)
