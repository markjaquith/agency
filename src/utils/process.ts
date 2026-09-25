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

interface OutputReader {
	readonly output: Promise<string>
	readonly cancel: () => Promise<void>
}

const readOutput = (
	stream: ReadableStream<Uint8Array> | null | undefined,
	target?: { write(chunk: Uint8Array): unknown },
): OutputReader => {
	if (!stream) {
		return { output: Promise.resolve(""), cancel: () => Promise.resolve() }
	}

	const reader = stream.getReader()
	return {
		output: (async () => {
			const decoder = new TextDecoder()
			let output = ""
			try {
				while (true) {
					const { done, value } = await reader.read()
					if (done) break
					target?.write(value)
					output += decoder.decode(value, { stream: true })
				}
				return output + decoder.decode()
			} finally {
				reader.releaseLock()
			}
		})(),
		cancel: () => reader.cancel(),
	}
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
	Effect.acquireUseRelease(
		Effect.try({
			try: () => {
				const detached = options?.timeoutMs !== undefined
				const proc = Bun.spawn([...args], {
					cwd: options?.cwd ?? process.cwd(),
					stdin: options?.stdin ?? "pipe",
					stdout: options?.stdout === "inherit" ? "inherit" : "pipe",
					stderr: options?.stderr === "inherit" ? "inherit" : "pipe",
					env: options?.env ? { ...process.env, ...options.env } : process.env,
					detached,
				})
				// Start draining stdout/stderr immediately so verbose subprocesses
				// cannot block on filled pipe buffers before they exit.
				const stdout =
					options?.stdout === "inherit"
						? readOutput(undefined)
						: readOutput(
								proc.stdout,
								options?.stdout === "tee" ? process.stdout : undefined,
							)
				const stderr =
					options?.stderr === "inherit"
						? readOutput(undefined)
						: readOutput(
								proc.stderr,
								options?.stderr === "tee" ? process.stderr : undefined,
							)

				let termination: Promise<void> | undefined
				const terminate = (): Promise<void> => {
					if (proc.exitCode !== null) return Promise.resolve()
					return (termination ??= (async () => {
						const signal = (name: "SIGTERM" | "SIGKILL") => {
							if (!detached) {
								proc.kill(name)
								return
							}
							try {
								process.kill(-proc.pid, name)
							} catch {
								proc.kill(name)
							}
						}
						signal("SIGTERM")
						const stopped = await Promise.race([
							proc.exited.then(() => true),
							Bun.sleep(250).then(() => false),
						])
						if (!stopped) signal("SIGKILL")
						await proc.exited
					})())
				}

				return {
					proc,
					stdout,
					stderr,
					terminate,
					startedAt: performance.now(),
					state: {
						timedOut: false,
						timer: undefined as ReturnType<typeof setTimeout> | undefined,
					},
				}
			},
			catch: (error) =>
				new ProcessError({
					command: args.join(" "),
					exitCode: -1,
					stderr: error instanceof Error ? error.message : String(error),
				}),
		}),
		({ proc, stdout, stderr, terminate, startedAt, state }) =>
			Effect.tryPromise({
				try: async () => {
					const exited =
						options?.timeoutMs === undefined
							? proc.exited
							: Promise.race([
									proc.exited,
									new Promise<number>((resolve) => {
										state.timer = setTimeout(async () => {
											state.timedOut = true
											await terminate()
											resolve(await proc.exited)
										}, options.timeoutMs)
									}),
								])
					const [exitCode, stdoutOutput, stderrOutput] = await Promise.all([
						exited,
						stdout.output,
						stderr.output,
					])
					if (state.timer) clearTimeout(state.timer)
					if (state.timedOut) {
						throw new ProcessError({
							command: args.join(" "),
							exitCode:
								typeof exitCode === "number" ? exitCode : (proc.exitCode ?? -1),
							stderr: stderrOutput.trim(),
							timedOut: true,
							timeoutMs: options?.timeoutMs,
							elapsedMs: Math.round(performance.now() - startedAt),
						})
					}

					return {
						stdout: stdoutOutput.trim(),
						stderr: stderrOutput.trim(),
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
			}),
		({ proc, stdout, stderr, terminate, state }) =>
			Effect.promise(async () => {
				if (state.timer) clearTimeout(state.timer)
				const terminating = terminate()
				await Promise.allSettled([stdout.cancel(), stderr.cancel()])
				await Promise.allSettled([
					terminating,
					proc.exited,
					stdout.output,
					stderr.output,
				])
			}),
	)
