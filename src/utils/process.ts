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
	readonly timeoutMs?: number
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
	timedOut?: boolean
	timeoutMs?: number
	elapsedMs?: number
}> {
	override get message(): string {
		if (this.timedOut) {
			return `Process timed out after ${this.elapsedMs ?? this.timeoutMs} ms: ${this.command}${this.stderr ? `\n${this.stderr}` : ""}`
		}
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
			const startedAt = performance.now()
			const proc = Bun.spawn([...args], {
				cwd: options?.cwd ?? process.cwd(),
				stdin: options?.stdin ?? "pipe",
				stdout: options?.stdout === "inherit" ? "inherit" : "pipe",
				stderr: options?.stderr === "inherit" ? "inherit" : "pipe",
				env: options?.env ? { ...process.env, ...options.env } : process.env,
				detached: options?.timeoutMs !== undefined,
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

			let timedOut = false
			let timer: ReturnType<typeof setTimeout> | undefined
			const exited =
				options?.timeoutMs === undefined
					? proc.exited
					: Promise.race([
							proc.exited,
							new Promise<number>((resolve) => {
								timer = setTimeout(async () => {
									timedOut = true
									try {
										process.kill(-proc.pid, "SIGTERM")
									} catch {
										proc.kill("SIGTERM")
									}
									const stopped = await Promise.race([
										proc.exited.then(() => true),
										Bun.sleep(250).then(() => false),
									])
									if (!stopped) {
										try {
											process.kill(-proc.pid, "SIGKILL")
										} catch {
											proc.kill("SIGKILL")
										}
									}
									resolve(await proc.exited)
								}, options.timeoutMs)
							}),
						])
			const [exitCode, stdout, stderr] = await Promise.all([
				exited,
				stdoutPromise,
				stderrPromise,
			])
			if (timer) clearTimeout(timer)
			if (timedOut) {
				throw new ProcessError({
					command: args.join(" "),
					exitCode:
						typeof exitCode === "number" ? exitCode : (proc.exitCode ?? -1),
					stderr: stderr.trim(),
					timedOut: true,
					timeoutMs: options?.timeoutMs,
					elapsedMs: Math.round(performance.now() - startedAt),
				})
			}

			return {
				stdout: stdout.trim(),
				stderr: stderr.trim(),
				exitCode:
					typeof exitCode === "number" ? exitCode : (proc.exitCode ?? 0),
			}
		},
		catch: (error) =>
			error instanceof ProcessError
				? error
				: new ProcessError({
						command: args.join(" "),
						exitCode: -1,
						stderr: error instanceof Error ? error.message : String(error),
					}),
	})
