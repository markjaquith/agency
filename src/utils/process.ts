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
	readonly stdout?: "pipe" | "inherit"
	readonly stderr?: "pipe" | "inherit"
	readonly env?: Record<string, string>
}

/**
 * Generic error for process execution failures
 */
export class ProcessError extends Data.TaggedError("ProcessError")<{
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
