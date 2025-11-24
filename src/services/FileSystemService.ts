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
		}),
	},
) {}
