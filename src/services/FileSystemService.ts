import { Effect, Data, pipe } from "effect"
import {
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
} from "node:fs/promises"
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
					catch: () => new FileNotFoundError({ path }),
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
						new FileSystemError({
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
					readonly env?: Record<string, string>
					readonly timeoutMs?: number
				},
			) =>
				pipe(
					spawnProcess(args, {
						cwd: options?.cwd,
						stdin: options?.passthrough ? "inherit" : "pipe",
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
					catch: () => null,
				}).pipe(Effect.catchAll(() => Effect.succeed(null))),
		}),
	},
) {}
