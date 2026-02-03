import { join, dirname, resolve, relative } from "node:path"
import { Data, Effect } from "effect"
import { Schema } from "@effect/schema"
import { AgencyMetadata } from "../schemas"
import { FileSystemService } from "./FileSystemService"
import { GitService } from "./GitService"
import { expandGlobs } from "../utils/glob"

/**
 * Error type for AgencyMetadata operations
 */
class AgencyMetadataError extends Data.TaggedError("AgencyMetadataError")<{
	message: string
	cause?: unknown
}> {}

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
 * Resolve symlink targets for a list of files.
 * For each file, if it's a symlink, also adds the target path to the result.
 * This ensures that when filtering files from git history, both the symlink
 * and its target are filtered (important when CLAUDE.md → AGENTS.md, for example).
 */
const resolveSymlinkTargets = (
	fs: FileSystemService,
	gitRoot: string,
	files: string[],
) =>
	Effect.gen(function* () {
		const result = new Set<string>(files)

		for (const file of files) {
			const fullPath = join(gitRoot, file)
			const target = yield* fs.readSymlinkTarget(fullPath)

			if (target) {
				// The target path could be relative or absolute
				// If relative, it's relative to the symlink's location
				// We need to normalize it to be relative to gitRoot
				let targetPath: string
				if (target.startsWith("/")) {
					// Absolute path - make it relative to gitRoot
					targetPath = relative(gitRoot, target)
				} else {
					// Relative path - resolve from the symlink's directory
					const symlinkDir = dirname(fullPath)
					const absoluteTarget = resolve(symlinkDir, target)
					targetPath = relative(gitRoot, absoluteTarget)
				}

				// Only add if it's within the gitRoot (not escaping the repo)
				if (!targetPath.startsWith("..")) {
					result.add(targetPath)
				}
			}
		}

		return Array.from(result)
	})

/**
 * Service for managing agency.json metadata operations
 */
export class AgencyMetadataService extends Effect.Service<AgencyMetadataService>()(
	"AgencyMetadataService",
	{
		sync: () => ({
			/**
			 * Read agency.json from disk in the repository root.
			 * Returns null if the file doesn't exist or is invalid.
			 */
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

			/**
			 * Read agency.json from a specific git branch using git show.
			 * Returns null if the file doesn't exist or is invalid.
			 */
			readFromBranch: (gitRoot: string, branch: string) =>
				Effect.gen(function* () {
					const git = yield* GitService

					// Try to read agency.json from the branch using git show
					const content = yield* git.getFileAtRef(
						gitRoot,
						branch,
						"agency.json",
					)

					if (!content) {
						return null
					}

					return yield* parseAgencyMetadata(content)
				}).pipe(Effect.catchAll(() => Effect.succeed(null))),

			/**
			 * Write agency.json to disk in the repository root.
			 */
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

			/**
			 * Get list of files to filter during PR/merge operations.
			 * Always includes TASK.md, AGENCY.md, and agency.json, plus any injectedFiles from metadata.
			 */
			getFilesToFilter: (gitRoot: string) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const metadataPath = join(gitRoot, "agency.json")

					const exists = yield* fs.exists(metadataPath)
					const baseFiles = ["TASK.md", "AGENCY.md", "agency.json"]

					if (!exists) {
						// Resolve symlinks even for base files
						return yield* resolveSymlinkTargets(fs, gitRoot, baseFiles)
					}

					const content = yield* fs
						.readFile(metadataPath)
						.pipe(Effect.catchAll(() => Effect.succeed("")))

					if (!content) {
						return yield* resolveSymlinkTargets(fs, gitRoot, baseFiles)
					}

					const metadata = yield* parseAgencyMetadata(content)

					if (!metadata) {
						return yield* resolveSymlinkTargets(fs, gitRoot, baseFiles)
					}

					// Expand any glob patterns in injectedFiles to actual file paths
					const expandedFiles = yield* Effect.tryPromise({
						try: () =>
							expandGlobs([...baseFiles, ...metadata.injectedFiles], gitRoot),
						catch: () => new Error("Failed to expand glob patterns"),
					})

					// Resolve symlinks and add their targets
					return yield* resolveSymlinkTargets(fs, gitRoot, expandedFiles)
				}).pipe(
					Effect.catchAll(() =>
						Effect.succeed(["TASK.md", "AGENCY.md", "agency.json"]),
					),
				),

			/**
			 * Get the configured base branch from agency.json metadata.
			 * Returns null if no metadata exists or no base branch is configured.
			 */
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

			/**
			 * Set the base branch in agency.json metadata.
			 */
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
					yield* fs.writeFile(metadataPath, outputContent).pipe(
						Effect.mapError(
							(error) =>
								new AgencyMetadataError({
									message: `Failed to write agency.json: ${error}`,
									cause: error,
								}),
						),
					)
					return void 0
				}),

			/**
			 * Parse and validate agency.json content from a JSON string.
			 * Returns null if the content is invalid.
			 */
			parse: parseAgencyMetadata,
		}),
	},
) {}

/**
 * Parse and validate agency.json content from a JSON string.
 * Returns null if the content is invalid.
 * This is exported as a standalone function for convenience since it has no dependencies.
 */
export { parseAgencyMetadata }
