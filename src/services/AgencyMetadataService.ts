import { join } from "node:path"
import { Context, Data, Effect, Layer } from "effect"
import { Schema } from "@effect/schema"
import { AgencyMetadata } from "../schemas"
import { FileSystemService } from "./FileSystemService"
import { GitService } from "./GitService"
import { expandGlobs } from "../utils/glob"

/**
 * Error type for AgencyMetadata operations
 */
export class AgencyMetadataError extends Data.TaggedError(
	"AgencyMetadataError",
)<{
	message: string
	cause?: unknown
}> {}

/**
 * Service for managing agency.json metadata operations
 */
export class AgencyMetadataService extends Context.Tag("AgencyMetadataService")<
	AgencyMetadataService,
	{
		/**
		 * Read agency.json from disk in the repository root.
		 * Returns null if the file doesn't exist or is invalid.
		 */
		readonly readFromDisk: (
			gitRoot: string,
		) => Effect.Effect<AgencyMetadata | null, never, FileSystemService>

		/**
		 * Read agency.json from a specific git branch using git show.
		 * Returns null if the file doesn't exist or is invalid.
		 */
		readonly readFromBranch: (
			gitRoot: string,
			branch: string,
		) => Effect.Effect<AgencyMetadata | null, never, GitService>

		/**
		 * Write agency.json to disk in the repository root.
		 */
		readonly write: (
			gitRoot: string,
			metadata: AgencyMetadata,
		) => Effect.Effect<void, AgencyMetadataError, FileSystemService>

		/**
		 * Get list of files to filter during PR/merge operations.
		 * Always includes TASK.md, AGENCY.md, and agency.json, plus any injectedFiles from metadata.
		 */
		readonly getFilesToFilter: (
			gitRoot: string,
		) => Effect.Effect<string[], never, FileSystemService>

		/**
		 * Get the configured base branch from agency.json metadata.
		 * Returns null if no metadata exists or no base branch is configured.
		 */
		readonly getBaseBranch: (
			gitRoot: string,
		) => Effect.Effect<string | null, never, FileSystemService>

		/**
		 * Set the base branch in agency.json metadata.
		 */
		readonly setBaseBranch: (
			gitRoot: string,
			baseBranch: string,
		) => Effect.Effect<void, AgencyMetadataError, FileSystemService>

		/**
		 * Parse and validate agency.json content from a JSON string.
		 * Returns null if the content is invalid.
		 */
		readonly parse: (content: string) => Effect.Effect<AgencyMetadata | null>
	}
>() {}

/**
 * Parse and validate agency.json content from a JSON string.
 * Returns null if the content is invalid.
 */
const parseAgencyMetadata = (content: string) =>
	Effect.gen(function* () {
		const data = yield* Effect.try({
			try: () => JSON.parse(content),
			catch: () => new Error("Failed to parse agency.json"),
		})

		// Validate version
		if (typeof data.version !== "number" || data.version !== 1) {
			return null
		}

		// Parse and validate using Effect schema
		const metadata = yield* Effect.try({
			try: () => Schema.decodeUnknownSync(AgencyMetadata)(data),
			catch: () => new Error("Invalid agency.json format"),
		})

		return metadata
	}).pipe(Effect.catchAll(() => Effect.succeed(null)))

/**
 * Implementation of AgencyMetadataService
 */
export const AgencyMetadataServiceLive = Layer.succeed(
	AgencyMetadataService,
	AgencyMetadataService.of({
		readFromDisk: (gitRoot: string) =>
			Effect.gen(function* () {
				const fs = yield* FileSystemService
				const metadataPath = join(gitRoot, "agency.json")

				const exists = yield* fs.exists(metadataPath)
				if (!exists) {
					return null
				}

				const content = yield* fs.readFile(metadataPath)
				return yield* parseAgencyMetadata(content)
			}).pipe(Effect.catchAll(() => Effect.succeed(null))),

		readFromBranch: (gitRoot: string, branch: string) =>
			Effect.gen(function* () {
				const git = yield* GitService

				// Try to read agency.json from the branch using git show
				const result = yield* git.runGitCommand(
					["git", "show", `${branch}:agency.json`],
					gitRoot,
					{ captureOutput: true },
				)

				if (result.exitCode !== 0 || !result.stdout) {
					return null
				}

				return yield* parseAgencyMetadata(result.stdout)
			}).pipe(Effect.catchAll(() => Effect.succeed(null))),

		write: (gitRoot: string, metadata: AgencyMetadata) =>
			Effect.gen(function* () {
				const fs = yield* FileSystemService
				const metadataPath = join(gitRoot, "agency.json")

				const content = JSON.stringify(metadata, null, 2) + "\n"
				yield* fs.writeFile(metadataPath, content).pipe(
					Effect.mapError(
						(error) =>
							new AgencyMetadataError({
								message: `Failed to write agency.json: ${error}`,
								cause: error,
							}),
					),
				)
			}),

		getFilesToFilter: (gitRoot: string) =>
			Effect.gen(function* () {
				const fs = yield* FileSystemService
				const metadataPath = join(gitRoot, "agency.json")

				const exists = yield* fs.exists(metadataPath)
				const baseFiles = ["TASK.md", "AGENCY.md", "agency.json"]

				if (!exists) {
					return baseFiles
				}

				const content = yield* fs
					.readFile(metadataPath)
					.pipe(Effect.catchAll(() => Effect.succeed("")))

				if (!content) {
					return baseFiles
				}

				const metadata = yield* parseAgencyMetadata(content)

				if (!metadata) {
					return baseFiles
				}

				// Expand any glob patterns in injectedFiles to actual file paths
				const expandedFiles = yield* Effect.tryPromise({
					try: () =>
						expandGlobs([...baseFiles, ...metadata.injectedFiles], gitRoot),
					catch: () => new Error("Failed to expand glob patterns"),
				})

				return expandedFiles
			}).pipe(
				Effect.catchAll(() =>
					Effect.succeed(["TASK.md", "AGENCY.md", "agency.json"]),
				),
			),

		getBaseBranch: (gitRoot: string) =>
			Effect.gen(function* () {
				const fs = yield* FileSystemService
				const metadataPath = join(gitRoot, "agency.json")

				const exists = yield* fs.exists(metadataPath)
				if (!exists) {
					return null
				}

				const content = yield* fs
					.readFile(metadataPath)
					.pipe(Effect.catchAll(() => Effect.succeed("")))

				if (!content) {
					return null
				}

				const metadata = yield* parseAgencyMetadata(content)
				return metadata?.baseBranch || null
			}).pipe(Effect.catchAll(() => Effect.succeed(null))),

		setBaseBranch: (gitRoot: string, baseBranch: string) =>
			Effect.gen(function* () {
				const fs = yield* FileSystemService
				const metadataPath = join(gitRoot, "agency.json")

				const exists = yield* fs.exists(metadataPath).pipe(
					Effect.mapError(
						(error) =>
							new AgencyMetadataError({
								message: `Failed to check agency.json: ${error}`,
								cause: error,
							}),
					),
				)

				if (!exists) {
					return yield* Effect.fail(
						new AgencyMetadataError({
							message:
								"agency.json not found. Please run 'agency task' first to initialize backpack files.",
						}),
					)
				}

				const content = yield* fs.readFile(metadataPath).pipe(
					Effect.mapError(
						(error) =>
							new AgencyMetadataError({
								message: `Failed to read agency.json: ${error}`,
								cause: error,
							}),
					),
				)

				const metadata = yield* parseAgencyMetadata(content).pipe(
					Effect.flatMap((m) =>
						m
							? Effect.succeed(m)
							: Effect.fail(
									new AgencyMetadataError({
										message:
											"agency.json is invalid. Please run 'agency task' first to initialize backpack files.",
									}),
								),
					),
				)

				// Create a new metadata instance with the updated baseBranch
				const updatedMetadata = new AgencyMetadata({
					version: metadata.version,
					injectedFiles: metadata.injectedFiles,
					template: metadata.template,
					createdAt: metadata.createdAt,
					baseBranch,
					emitBranch: metadata.emitBranch,
				})

				const outputContent = JSON.stringify(updatedMetadata, null, 2) + "\n"
				return yield* fs.writeFile(metadataPath, outputContent).pipe(
					Effect.mapError(
						(error) =>
							new AgencyMetadataError({
								message: `Failed to write agency.json: ${error}`,
								cause: error,
							}),
					),
				)
			}),

		parse: parseAgencyMetadata,
	}),
)
