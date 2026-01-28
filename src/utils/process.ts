import { Effect, Data } from "effect"

/**
 * Result of a process execution
 */
interface ProcessResult {
	readonly stdout: string
	readonly stderr: string
	readonly exitCode: number
}

/**
 * Options for spawning a process
 */
interface SpawnOptions {
	readonly cwd?: string
	readonly stdin?: "pipe" | "inherit"
	readonly stdout?: "pipe" | "inherit"
	readonly stderr?: "pipe" | "inherit"
	readonly env?: Record<string, string>
}

/**
 * Generic error for process execution failures
 */
class ProcessError extends Data.TaggedError("ProcessError")<{
	command: string
	exitCode: number
	stderr: string
}> {}

/**
 * Spawn a process with proper error handling and typed results.
 * This is a low-level utility that returns raw process results.
 * Use higher-level wrappers for specific error types.
 */
export const spawnProcess = (
	args: readonly string[],
	options?: SpawnOptions,
): Effect.Effect<ProcessResult, ProcessError> =>
	Effect.tryPromise({
		try: async () => {
			const proc = Bun.spawn([...args], {
				cwd: options?.cwd ?? process.cwd(),
				stdin: options?.stdin ?? "pipe",
				stdout: options?.stdout ?? "pipe",
				stderr: options?.stderr ?? "pipe",
				env: options?.env ? { ...process.env, ...options.env } : process.env,
			})

			await proc.exited

			const stdout =
				options?.stdout === "inherit"
					? ""
					: await new Response(proc.stdout).text()
			const stderr =
				options?.stderr === "inherit"
					? ""
					: await new Response(proc.stderr).text()

			return {
				stdout: stdout.trim(),
				stderr: stderr.trim(),
				exitCode: proc.exitCode ?? 0,
			}
		},
		catch: (error) =>
			new ProcessError({
				command: args.join(" "),
				exitCode: -1,
				stderr: error instanceof Error ? error.message : String(error),
			}),
	})

/**
 * Helper to check exit code and return stdout on success
 */
export const checkExitCodeAndReturnStdout =
	<E>(errorMapper: (result: ProcessResult) => E) =>
	(result: ProcessResult): Effect.Effect<string, E> =>
		result.exitCode === 0
			? Effect.succeed(result.stdout)
			: Effect.fail(errorMapper(result))

/**
 * Helper to check exit code and return void on success
 */
export const checkExitCodeAndReturnVoid =
	<E>(errorMapper: (result: ProcessResult) => E) =>
	(result: ProcessResult): Effect.Effect<void, E> =>
		result.exitCode === 0 ? Effect.void : Effect.fail(errorMapper(result))

/**
 * Helper to create an error mapper function for a specific error type
 * This is useful for wrapping spawnProcess with domain-specific error types
 */
export const createErrorMapper =
	<E extends { command: string; exitCode: number; stderr: string }>(
		ErrorConstructor: new (args: {
			command: string
			exitCode: number
			stderr: string
		}) => E,
	) =>
	(args: readonly string[]) =>
	(result: ProcessResult): E =>
		new ErrorConstructor({
			command: args.join(" "),
			exitCode: result.exitCode,
			stderr: result.stderr,
		})
