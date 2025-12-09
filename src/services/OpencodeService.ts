import { Effect, Data } from "effect"
import { parse as parseJsonc, type ParseError } from "jsonc-parser"
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

interface OpencodeFileInfo {
	extension: "json" | "jsonc"
	relativePath: string
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
			 * Checks in order: .opencode/opencode.jsonc, .opencode/opencode.json,
			 * opencode.jsonc, opencode.json
			 * Returns the file info if found, null otherwise.
			 */
			detectOpencodeFile: (gitRoot: string) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService

					// Check .opencode directory first
					const dotOpencodeJsoncPath = `${gitRoot}/.opencode/opencode.jsonc`
					const dotOpencodeJsoncExists = yield* fs.exists(dotOpencodeJsoncPath)
					if (dotOpencodeJsoncExists) {
						return {
							extension: "jsonc" as const,
							relativePath: ".opencode/opencode.jsonc",
						}
					}

					const dotOpencodeJsonPath = `${gitRoot}/.opencode/opencode.json`
					const dotOpencodeJsonExists = yield* fs.exists(dotOpencodeJsonPath)
					if (dotOpencodeJsonExists) {
						return {
							extension: "json" as const,
							relativePath: ".opencode/opencode.json",
						}
					}

					// Check for opencode.jsonc in root (takes precedence over opencode.json)
					const jsoncPath = `${gitRoot}/opencode.jsonc`
					const jsoncExists = yield* fs.exists(jsoncPath)
					if (jsoncExists) {
						return {
							extension: "jsonc" as const,
							relativePath: "opencode.jsonc",
						}
					}

					// Check for opencode.json in root
					const jsonPath = `${gitRoot}/opencode.json`
					const jsonExists = yield* fs.exists(jsonPath)
					if (jsonExists) {
						return { extension: "json" as const, relativePath: "opencode.json" }
					}

					return null
				}),

			/**
			 * Parse JSON or JSONC content using jsonc-parser for robust comment handling.
			 */
			parseConfig: (content: string, extension: "json" | "jsonc") =>
				Effect.try({
					try: () => {
						if (extension === "jsonc") {
							// Use jsonc-parser for robust JSONC parsing with comments and trailing commas
							const errors: ParseError[] = []
							const result = parseJsonc(content, errors, {
								allowTrailingComma: true,
							}) as OpencodeConfig

							// Check if there were any parse errors
							if (errors.length > 0) {
								throw new Error(
									`JSON Parse error: ${errors.map((e) => `Error code ${e.error} at offset ${e.offset}`).join(", ")}`,
								)
							}

							return result
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
			 * Returns the relative path of the file that was written.
			 */
			mergeOpencodeFile: (gitRoot: string, instructionsToAdd: string[]) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService

					// Detect which file exists
					const fileInfo = yield* Effect.gen(function* () {
						const detected = yield* Effect.gen(function* () {
							// Check .opencode directory first
							const dotOpencodeJsoncPath = `${gitRoot}/.opencode/opencode.jsonc`
							const dotOpencodeJsoncExists =
								yield* fs.exists(dotOpencodeJsoncPath)
							if (dotOpencodeJsoncExists) {
								return {
									extension: "jsonc" as const,
									relativePath: ".opencode/opencode.jsonc",
								}
							}

							const dotOpencodeJsonPath = `${gitRoot}/.opencode/opencode.json`
							const dotOpencodeJsonExists =
								yield* fs.exists(dotOpencodeJsonPath)
							if (dotOpencodeJsonExists) {
								return {
									extension: "json" as const,
									relativePath: ".opencode/opencode.json",
								}
							}

							// Check root directory
							const jsoncPath = `${gitRoot}/opencode.jsonc`
							const jsoncExists = yield* fs.exists(jsoncPath)
							if (jsoncExists) {
								return {
									extension: "jsonc" as const,
									relativePath: "opencode.jsonc",
								}
							}

							const jsonPath = `${gitRoot}/opencode.json`
							const jsonExists = yield* fs.exists(jsonPath)
							if (jsonExists) {
								return {
									extension: "json" as const,
									relativePath: "opencode.json",
								}
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

					const filepath = `${gitRoot}/${fileInfo.relativePath}`

					// Read existing config
					const content = yield* fs.readFile(filepath)

					// Parse it
					const existingConfig = yield* Effect.gen(function* () {
						if (fileInfo.extension === "jsonc") {
							const errors: ParseError[] = []
							const result = parseJsonc(content, errors, {
								allowTrailingComma: true,
							}) as OpencodeConfig

							// Check if there were any parse errors
							if (errors.length > 0) {
								throw new Error(
									`JSON Parse error: ${errors.map((e) => `Error code ${e.error} at offset ${e.offset}`).join(", ")}`,
								)
							}

							return result
						}
						return JSON.parse(content) as OpencodeConfig
					}).pipe(
						Effect.catchAll((error) =>
							Effect.fail(
								new OpencodeError({
									message: `Failed to parse ${fileInfo.relativePath}`,
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

					return fileInfo.relativePath
				}),
		}),
	},
) {}
