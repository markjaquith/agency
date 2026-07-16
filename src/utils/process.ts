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
	readonly stdout?: "pipe" | "inherit" | "tee"
	readonly stderr?: "pipe" | "inherit" | "tee"
	readonly env?: Record<string, string>
}

const readOutput = async (
	stream: ReadableStream<Uint8Array> | null | undefined,
	target?: { write(chunk: Uint8Array): unknown },
) => {
	if (!stream) return ""

	const reader = stream.getReader()
	const decoder = new TextDecoder()
	let output = ""
	while (true) {
		const { done, value } = await reader.read()
		if (done) break
		target?.write(value)
		output += decoder.decode(value, { stream: true })
	}
	return output + decoder.decode()
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
				stdout: options?.stdout === "inherit" ? "inherit" : "pipe",
				stderr: options?.stderr === "inherit" ? "inherit" : "pipe",
				env: options?.env ? { ...process.env, ...options.env } : process.env,
			})
			// Start draining stdout/stderr immediately so verbose subprocesses
			// cannot block on filled pipe buffers before they exit.
			const stdoutPromise =
				options?.stdout === "inherit"
					? Promise.resolve("")
					: readOutput(
							proc.stdout,
							options?.stdout === "tee" ? process.stdout : undefined,
						)
			const stderrPromise =
				options?.stderr === "inherit"
					? Promise.resolve("")
					: readOutput(
							proc.stderr,
							options?.stderr === "tee" ? process.stderr : undefined,
						)

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
