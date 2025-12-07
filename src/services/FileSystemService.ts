import { Effect, Data, pipe } from "effect"
import { mkdir, copyFile as fsCopyFile, unlink } from "node:fs/promises"
import { spawnProcess } from "../utils/process"

// Error types for FileSystem operations
class FileSystemError extends Data.TaggedError("FileSystemError")<{
	message: string
	cause?: unknown
}> {}

class FileNotFoundError extends Data.TaggedError("FileNotFoundError")<{
	path: string
}> {}

// FileSystem Service using Effect.Service pattern
export class FileSystemService extends Effect.Service<FileSystemService>()(
	"FileSystemService",
	{
		sync: () => ({
			exists: (path: string) =>
				Effect.tryPromise({
					try: async () => {
						const file = Bun.file(path)
						return await file.exists()
					},
					catch: () =>
						new FileSystemError({
							message: `Failed to check if file exists: ${path}`,
						}),
				}),

			isDirectory: (path: string) =>
				Effect.tryPromise({
					try: async () => {
						const file = Bun.file(path)
						const exists = await file.exists()
						if (!exists) {
							return false
						}
						// Use stat to check if it's a directory
						const stat = await import("node:fs/promises").then((fs) =>
							fs.stat(path),
						)
						return stat.isDirectory()
					},
					catch: () =>
						new FileSystemError({
							message: `Failed to check if path is directory: ${path}`,
						}),
				}),

			readFile: (path: string) =>
				Effect.tryPromise({
					try: async () => {
						const file = Bun.file(path)
						const exists = await file.exists()
						if (!exists) {
							throw new Error(`File not found: ${path}`)
						}
						return await file.text()
					},
					catch: () => new FileNotFoundError({ path }),
				}),

			writeFile: (path: string, content: string) =>
				Effect.tryPromise({
					try: () => Bun.write(path, content),
					catch: (error) =>
						new FileSystemError({
							message: `Failed to write file: ${path}`,
							cause: error,
						}),
				}),

			readJSON: <T = unknown>(path: string) =>
				Effect.tryPromise({
					try: async (): Promise<T> => {
						const file = Bun.file(path)
						const exists = await file.exists()
						if (!exists) {
							throw new Error(`File not found: ${path}`)
						}
						return await file.json()
					},
					catch: () => new FileNotFoundError({ path }),
				}),

			writeJSON: <T = unknown>(path: string, data: T) =>
				Effect.tryPromise({
					try: () => Bun.write(path, JSON.stringify(data, null, 2) + "\n"),
					catch: (error) =>
						new FileSystemError({
							message: `Failed to write JSON file: ${path}`,
							cause: error,
						}),
				}),

			createDirectory: (path: string) =>
				Effect.tryPromise({
					try: () => mkdir(path, { recursive: true }),
					catch: (error) =>
						new FileSystemError({
							message: `Failed to create directory: ${path}`,
							cause: error,
						}),
				}),

			deleteFile: (path: string) =>
				Effect.tryPromise({
					try: () => unlink(path),
					catch: (error) =>
						new FileSystemError({
							message: `Failed to delete file: ${path}`,
							cause: error,
						}),
				}),

			copyFile: (from: string, to: string) =>
				Effect.tryPromise({
					try: () => fsCopyFile(from, to),
					catch: (error) =>
						new FileSystemError({
							message: `Failed to copy file from ${from} to ${to}`,
							cause: error,
						}),
				}),

			deleteDirectory: (path: string) =>
				pipe(
					spawnProcess(["rm", "-rf", path]),
					Effect.flatMap((result) =>
						result.exitCode === 0
							? Effect.void
							: Effect.fail(
									new FileSystemError({
										message: `Failed to delete directory: ${path}`,
										cause: result.stderr,
									}),
								),
					),
					Effect.mapError(
						(error) =>
							new FileSystemError({
								message: `Failed to delete directory: ${path}`,
								cause: error,
							}),
					),
				),

			runCommand: (
				args: readonly string[],
				options?: {
					readonly cwd?: string
					readonly captureOutput?: boolean
				},
			) =>
				pipe(
					spawnProcess(args, {
						cwd: options?.cwd,
						stdout: options?.captureOutput ? "pipe" : "inherit",
						stderr: "pipe",
					}),
					Effect.mapError(
						(processError) =>
							new FileSystemError({
								message: `Failed to run command: ${args.join(" ")}`,
								cause: processError,
							}),
					),
				),

			/**
			 * Recursively collect all files in a directory.
			 * Returns paths relative to the directory (or relativeTo if specified).
			 */
			collectFiles: (
				dirPath: string,
				options?: {
					readonly relativeTo?: string
					readonly exclude?: readonly string[]
					readonly sort?: boolean
				},
			) =>
				Effect.tryPromise({
					try: async () => {
						const { relativeTo, exclude = [], sort = false } = options ?? {}
						const basePath = relativeTo ?? dirPath

						// Build find command with exclusions
						const findArgs = ["find", dirPath, "-type", "f"]
						for (const pattern of exclude) {
							findArgs.push("!", "-name", pattern)
						}

						const result = Bun.spawnSync(findArgs, {
							stdout: "pipe",
							stderr: "ignore",
						})

						const output = new TextDecoder().decode(result.stdout)
						if (!output) {
							return []
						}

						const files = output
							.trim()
							.split("\n")
							.filter((f: string) => f.length > 0)
							.map((file) => file.replace(basePath + "/", ""))
							.filter((f) => f.length > 0)

						return sort ? files.sort() : files
					},
					catch: (error) =>
						new FileSystemError({
							message: `Failed to collect files from ${dirPath}`,
							cause: error,
						}),
				}),
		}),
	},
) {}
