import { Effect, Data } from "effect"
import { mkdir, copyFile as fsCopyFile, unlink } from "node:fs/promises"

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
					try: async () => {
						try {
							await Bun.write(path, content)
						} catch {}
					},
					catch: () =>
						new FileSystemError({
							message: `Failed to write file: ${path}`,
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
					try: async () => {
						try {
							await mkdir(path, { recursive: true })
						} catch {}
					},
					catch: () =>
						new FileSystemError({
							message: `Failed to create directory: ${path}`,
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
				Effect.tryPromise({
					try: async () => {
						const proc = Bun.spawn(["rm", "-rf", path], {
							stdout: "pipe",
							stderr: "pipe",
						})
						await proc.exited
						if (proc.exitCode !== 0) {
							const stderr = await new Response(proc.stderr).text()
							throw new Error(`Failed to delete directory: ${stderr}`)
						}
					},
					catch: (error) =>
						new FileSystemError({
							message: `Failed to delete directory: ${path}`,
							cause: error,
						}),
				}),

			runCommand: (
				args: readonly string[],
				options?: {
					readonly cwd?: string
					readonly captureOutput?: boolean
				},
			) =>
				Effect.tryPromise({
					try: async () => {
						const proc = Bun.spawn([...args], {
							cwd: options?.cwd || process.cwd(),
							stdout: options?.captureOutput ? "pipe" : "inherit",
							stderr: "pipe",
						})

						await proc.exited

						const stdout = options?.captureOutput
							? await new Response(proc.stdout).text()
							: ""
						const stderr = await new Response(proc.stderr).text()

						return {
							stdout: stdout.trim(),
							stderr: stderr.trim(),
							exitCode: proc.exitCode ?? 0,
						}
					},
					catch: (error) =>
						new FileSystemError({
							message: `Failed to run command: ${args.join(" ")}`,
							cause: error,
						}),
				}),

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
