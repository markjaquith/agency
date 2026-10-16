import { Effect, Data, pipe, Context, Layer } from "effect"
import {
	appendFile,
	mkdir,
	lstat,
	readlink,
	readdir,
	realpath,
	rename,
	rmdir,
	stat,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { spawnProcess } from "../utils/process"

// Error types for FileSystem operations
class FileSystemError extends Data.TaggedError("FileSystemError")<{
	message: string
	cause?: unknown
}> {}

class FileNotFoundError extends Data.TaggedError("FileNotFoundError")<{
	path: string
}> {}

const isFileNotFound = (error: unknown) =>
	typeof error === "object" &&
	error !== null &&
	"code" in error &&
	error.code === "ENOENT"

// FileSystem Service using Context.Service pattern
export class FileSystemService extends Context.Service<FileSystemService>()(
	"FileSystemService",
	{
		make: Effect.sync(() => ({
			exists: (path: string) =>
				Effect.tryPromise({
					try: async () => {
						try {
							await lstat(path)
							return true
						} catch (error) {
							if (
								typeof error === "object" &&
								error !== null &&
								"code" in error &&
								error.code === "ENOENT"
							) {
								return false
							}
							throw error
						}
					},
					catch: () =>
						new FileSystemError({
							message: `Failed to check if file exists: ${path}`,
						}),
				}),

			isDirectory: (path: string) =>
				Effect.tryPromise({
					try: async () => {
						try {
							return (await stat(path)).isDirectory()
						} catch (error) {
							if (
								typeof error === "object" &&
								error !== null &&
								"code" in error &&
								error.code === "ENOENT"
							) {
								return false
							}
							throw error
						}
					},
					catch: () =>
						new FileSystemError({
							message: `Failed to check if path is directory: ${path}`,
						}),
				}),

			realPath: (path: string) =>
				Effect.tryPromise({
					try: () => realpath(path),
					catch: (error) =>
						new FileSystemError({
							message: `Failed to resolve path: ${path}`,
							cause: error,
						}),
				}),

			readFile: (path: string) =>
				Effect.tryPromise({
					try: () => Bun.file(path).text(),
					catch: (error) =>
						isFileNotFound(error)
							? new FileNotFoundError({ path })
							: new FileSystemError({
									message: `Failed to read file: ${path}`,
									cause: error,
								}),
				}),

			inspectFile: (path: string) =>
				Effect.tryPromise({
					try: async () => {
						try {
							const stats = await lstat(path)
							if (stats.isSymbolicLink()) {
								return { kind: "symlink" as const }
							}
							if (!stats.isFile()) return { kind: "other" as const }
							return {
								kind: "file" as const,
								content: await Bun.file(path).text(),
							}
						} catch (error) {
							if (
								typeof error === "object" &&
								error !== null &&
								"code" in error &&
								error.code === "ENOENT"
							) {
								return { kind: "missing" as const }
							}
							throw error
						}
					},
					catch: (error) =>
						new FileSystemError({
							message: `Failed to inspect file: ${path}`,
							cause: error,
						}),
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

			appendFile: (path: string, content: string) =>
				Effect.tryPromise({
					try: () => appendFile(path, content),
					catch: (error) =>
						new FileSystemError({
							message: `Failed to append to file: ${path}`,
							cause: error,
						}),
				}),

			/** Write through a uniquely named temporary file and an atomic rename. */
			writeFileAtomic: (path: string, content: string) =>
				Effect.tryPromise({
					try: async () => {
						const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
						try {
							await writeFile(temporary, content)
							await rename(temporary, path)
						} catch (error) {
							await unlink(temporary).catch(() => undefined)
							throw error
						}
					},
					catch: (error) =>
						new FileSystemError({
							message: `Failed to write file: ${path}`,
							cause: error,
						}),
				}),

			/** Create a file only if it does not exist; false when it already does. */
			createExclusive: (path: string, content: string) =>
				Effect.tryPromise({
					try: async () => {
						try {
							await writeFile(path, content, { flag: "wx" })
							return true
						} catch (error) {
							if (
								typeof error === "object" &&
								error !== null &&
								"code" in error &&
								error.code === "EEXIST"
							)
								return false
							throw error
						}
					},
					catch: (error) =>
						new FileSystemError({
							message: `Failed to create file: ${path}`,
							cause: error,
						}),
				}),

			/** Modification time in milliseconds, or null when the path is missing. */
			modifiedAt: (path: string) =>
				Effect.tryPromise({
					try: async () => {
						try {
							return (await stat(path)).mtimeMs
						} catch (error) {
							if (isFileNotFound(error)) return null
							throw error
						}
					},
					catch: (error) =>
						new FileSystemError({
							message: `Failed to inspect file: ${path}`,
							cause: error,
						}),
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

			deleteFile: (path: string) =>
				Effect.tryPromise({
					try: () => unlink(path),
					catch: (error) =>
						new FileSystemError({
							message: `Failed to delete file: ${path}`,
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

			moveDirectory: (from: string, to: string) =>
				Effect.tryPromise({
					try: () => rename(from, to),
					catch: (error) =>
						new FileSystemError({
							message: `Failed to move directory from ${from} to ${to}`,
							cause: error,
						}),
				}),

			readDirectory: (path: string) =>
				Effect.tryPromise({
					try: async () => {
						const entries = await readdir(path, { withFileTypes: true })
						return entries.map((entry) => ({
							name: entry.name,
							isDirectory: entry.isDirectory(),
							isSymlink: entry.isSymbolicLink(),
						}))
					},
					catch: (error) =>
						isFileNotFound(error)
							? new FileNotFoundError({ path })
							: new FileSystemError({
									message: `Failed to read directory: ${path}`,
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

			deleteDirectoryIfEmpty: (path: string) =>
				Effect.tryPromise({
					try: async () => {
						try {
							await rmdir(path)
							return true
						} catch (error) {
							if (
								typeof error === "object" &&
								error !== null &&
								"code" in error &&
								["ENOENT", "ENOTEMPTY", "EEXIST"].includes(String(error.code))
							) {
								return false
							}
							throw error
						}
					},
					catch: (error) =>
						new FileSystemError({
							message: `Failed to delete empty directory: ${path}`,
							cause: error,
						}),
				}),

			runCommand: (
				args: readonly string[],
				options?: {
					readonly cwd?: string
					readonly captureOutput?: boolean
					readonly forwardOutput?: boolean
					readonly passthrough?: boolean
					/** Give the process no stdin, for commands that read piped input. */
					readonly ignoreStdin?: boolean
					readonly env?: Record<string, string>
					/** Use `env` as the whole environment instead of extending it. */
					readonly replaceEnv?: boolean
					readonly timeoutMs?: number
				},
			) =>
				pipe(
					spawnProcess(args, {
						cwd: options?.cwd,
						stdin: options?.passthrough
							? "inherit"
							: options?.ignoreStdin
								? "ignore"
								: "pipe",
						stdout: options?.passthrough
							? "inherit"
							: options?.forwardOutput
								? "tee"
								: options?.captureOutput
									? "pipe"
									: "inherit",
						stderr: options?.passthrough
							? "inherit"
							: options?.forwardOutput
								? "tee"
								: "pipe",
						env: options?.env,
						replaceEnv: options?.replaceEnv,
						timeoutMs: options?.timeoutMs,
					}),
					Effect.mapError(
						(processError) =>
							new FileSystemError({
								message: options?.passthrough
									? processError.message
									: `Failed to run command: ${args.join(" ")}`,
								cause: processError,
							}),
					),
				),

			createSymlink: (target: string, path: string) =>
				Effect.tryPromise({
					try: () => symlink(target, path, "dir"),
					catch: (error) =>
						new FileSystemError({
							message: `Failed to create symlink ${path} -> ${target}`,
							cause: error,
						}),
				}),

			/**
			 * Read the target of a symbolic link.
			 * Returns null if the file is not a symlink or doesn't exist.
			 */
			readSymlinkTarget: (path: string) =>
				Effect.tryPromise({
					try: async () => {
						const stats = await lstat(path)
						if (!stats.isSymbolicLink()) {
							return null
						}
						return await readlink(path)
					},
					catch: (error) =>
						isFileNotFound(error)
							? new FileNotFoundError({ path })
							: new FileSystemError({
									message: `Failed to read symlink target: ${path}`,
									cause: error,
								}),
				}).pipe(
					Effect.catchTag("FileNotFoundError", () => Effect.succeed(null)),
				),
		})),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
