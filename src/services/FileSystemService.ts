import { Effect, Context, Data } from "effect"

// Error types for FileSystem operations
export class FileSystemError extends Data.TaggedError("FileSystemError")<{
	message: string
	cause?: unknown
}> {}

export class FileNotFoundError extends Data.TaggedError("FileNotFoundError")<{
	path: string
}> {}

class DirectoryNotFoundError extends Data.TaggedError(
	"DirectoryNotFoundError",
)<{
	path: string
}> {}

// FileSystem Service interface
export class FileSystemService extends Context.Tag("FileSystemService")<
	FileSystemService,
	{
		readonly exists: (path: string) => Effect.Effect<boolean, FileSystemError>
		readonly readFile: (
			path: string,
		) => Effect.Effect<string, FileNotFoundError>
		readonly writeFile: (
			path: string,
			content: string,
		) => Effect.Effect<void, FileSystemError>
		readonly readJSON: <T>(path: string) => Effect.Effect<T, FileNotFoundError>
		readonly writeJSON: <T>(
			path: string,
			data: T,
		) => Effect.Effect<void, FileSystemError>
		readonly createDirectory: (
			path: string,
		) => Effect.Effect<void, FileSystemError>
		readonly deleteFile: (path: string) => Effect.Effect<void, FileSystemError>
		readonly copyFile: (
			from: string,
			to: string,
		) => Effect.Effect<void, FileSystemError>
		readonly deleteDirectory: (
			path: string,
		) => Effect.Effect<void, FileSystemError>
		readonly runCommand: (
			args: readonly string[],
			options?: {
				readonly cwd?: string
				readonly captureOutput?: boolean
			},
		) => Effect.Effect<
			{ stdout: string; stderr: string; exitCode: number },
			FileSystemError
		>
	}
>() {}
