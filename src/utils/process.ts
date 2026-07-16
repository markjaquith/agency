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
}> {
	override get message(): string {
		return (
			this.stderr ||
			`Process failed with exit code ${this.exitCode}: ${this.command}`
		)
	}
}

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
			// Start draining stdout/stderr immediately so verbose subprocesses
			// cannot block on filled pipe buffers before they exit.
			const stdoutPromise =
				options?.stdout === "inherit"
					? Promise.resolve("")
					: new Response(proc.stdout ?? "").text()
			const stderrPromise =
				options?.stderr === "inherit"
					? Promise.resolve("")
					: new Response(proc.stderr ?? "").text()

			const [exitCode, stdout, stderr] = await Promise.all([
				proc.exited,
				stdoutPromise,
				stderrPromise,
			])

			return {
				stdout: stdout.trim(),
				stderr: stderr.trim(),
				exitCode:
					typeof exitCode === "number" ? exitCode : (proc.exitCode ?? 0),
			}
		},
		catch: (error) =>
			new ProcessError({
				command: args.join(" "),
				exitCode: -1,
				stderr: error instanceof Error ? error.message : String(error),
			}),
	})
