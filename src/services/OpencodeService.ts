import { Effect, Data } from "effect"
import { FileSystemService } from "./FileSystemService"

// Error types for Opencode operations
class OpencodeError extends Data.TaggedError("OpencodeError")<{
	message: string
	cause?: unknown
}> {}

interface OpencodeConfig {
	instructions?: string[]
	[key: string]: unknown
}

/**
 * Service for handling opencode.json/opencode.jsonc files
 * with merging capabilities to preserve existing configuration.
 */
export class OpencodeService extends Effect.Service<OpencodeService>()(
	"OpencodeService",
	{
		sync: () => ({
			/**
			 * Detect which opencode config file exists (json or jsonc).
			 * Returns the file extension if found, null otherwise.
			 */
			detectOpencodeFile: (gitRoot: string) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService

					// Check for opencode.jsonc first (takes precedence)
					const jsoncPath = `${gitRoot}/opencode.jsonc`
					const jsoncExists = yield* fs.exists(jsoncPath)
					if (jsoncExists) {
						return "jsonc" as const
					}

					// Check for opencode.json
					const jsonPath = `${gitRoot}/opencode.json`
					const jsonExists = yield* fs.exists(jsonPath)
					if (jsonExists) {
						return "json" as const
					}

					return null
				}),

			/**
			 * Parse JSON or JSONC content, stripping comments for JSONC.
			 */
			parseConfig: (content: string, extension: "json" | "jsonc") =>
				Effect.try({
					try: () => {
						if (extension === "jsonc") {
							// Strip comments from JSONC (simple implementation)
							// Removes single-line (//) and multi-line (/* */) comments
							const withoutComments = content
								.replace(/\/\*[\s\S]*?\*\//g, "")
								.replace(/\/\/.*/g, "")
							return JSON.parse(withoutComments) as OpencodeConfig
						}
						return JSON.parse(content) as OpencodeConfig
					},
					catch: (error) =>
						new OpencodeError({
							message: `Failed to parse opencode.${extension}`,
							cause: error,
						}),
				}),

			/**
			 * Merge our instructions into an existing opencode config.
			 * Preserves all existing properties and adds our instructions to the array.
			 */
			mergeConfig: (
				existingConfig: OpencodeConfig,
				instructionsToAdd: string[],
			) =>
				Effect.sync(() => {
					const merged = { ...existingConfig }

					// Get existing instructions or initialize empty array
					const existingInstructions = Array.isArray(merged.instructions)
						? merged.instructions
						: []

					// Add our instructions, avoiding duplicates
					const newInstructions = instructionsToAdd.filter(
						(instruction) => !existingInstructions.includes(instruction),
					)

					// Update instructions array
					merged.instructions = [...existingInstructions, ...newInstructions]

					return merged
				}),

			/**
			 * Format the config back to string, preserving formatting.
			 * For JSONC, we use JSON formatting (comments are not preserved).
			 */
			formatConfig: (config: OpencodeConfig) =>
				Effect.sync(() => JSON.stringify(config, null, "\t") + "\n"),

			/**
			 * Read, merge, and write the opencode config file.
			 * Returns the filename that was written.
			 */
			mergeOpencodeFile: (gitRoot: string, instructionsToAdd: string[]) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService

					// Detect which file exists
					const extension = yield* Effect.gen(function* () {
						const detected = yield* Effect.gen(function* () {
							const jsoncPath = `${gitRoot}/opencode.jsonc`
							const jsoncExists = yield* fs.exists(jsoncPath)
							if (jsoncExists) {
								return "jsonc" as const
							}

							const jsonPath = `${gitRoot}/opencode.json`
							const jsonExists = yield* fs.exists(jsonPath)
							if (jsonExists) {
								return "json" as const
							}

							return null
						})

						if (!detected) {
							return yield* Effect.fail(
								new OpencodeError({
									message: "No opencode.json or opencode.jsonc file found",
								}),
							)
						}

						return detected
					})

					const filename = `opencode.${extension}`
					const filepath = `${gitRoot}/${filename}`

					// Read existing config
					const content = yield* fs.readFile(filepath)

					// Parse it
					const existingConfig = yield* Effect.gen(function* () {
						if (extension === "jsonc") {
							const withoutComments = content
								.replace(/\/\*[\s\S]*?\*\//g, "")
								.replace(/\/\/.*/g, "")
							return JSON.parse(withoutComments) as OpencodeConfig
						}
						return JSON.parse(content) as OpencodeConfig
					}).pipe(
						Effect.catchAll((error) =>
							Effect.fail(
								new OpencodeError({
									message: `Failed to parse ${filename}`,
									cause: error,
								}),
							),
						),
					)

					// Merge with our instructions
					const merged = yield* Effect.sync(() => {
						const result = { ...existingConfig }
						const existingInstructions = Array.isArray(result.instructions)
							? result.instructions
							: []
						const newInstructions = instructionsToAdd.filter(
							(instruction) => !existingInstructions.includes(instruction),
						)
						result.instructions = [...existingInstructions, ...newInstructions]
						return result
					})

					// Format and write back
					const formattedContent = JSON.stringify(merged, null, "\t") + "\n"
					yield* fs.writeFile(filepath, formattedContent)

					return filename
				}),
		}),
	},
) {}
