import { Data, Effect } from "effect"
import { open, rm, stat } from "node:fs/promises"
import { join } from "node:path"

class WorktreeLockError extends Data.TaggedError("WorktreeLockError")<{
	readonly message: string
	readonly cause?: unknown
}> {}

export interface WorktreeLockTarget {
	readonly taskId: string
	readonly phaseId?: string
}

export interface WorktreeLockOptions {
	readonly force?: boolean
}

const lockTimeoutMs = 10 * 60 * 1000

const isErrorCode = (cause: unknown, code: string) =>
	typeof cause === "object" &&
	cause !== null &&
	"code" in cause &&
	cause.code === code

const withWorktreeLock = <A, E, R>(
	root: string,
	target: WorktreeLockTarget,
	effect: Effect.Effect<A, E, R>,
	options: WorktreeLockOptions,
): Effect.Effect<A, E | WorktreeLockError, R> => {
	const key = Buffer.from(
		`${target.taskId}:${target.phaseId ?? "task"}`,
	).toString("hex")
	const lockPath = join(root, `.agency-worktree-${key}.lock`)
	const removalCommand = `rm '${lockPath.replaceAll("'", `'\\''`)}'`
	return Effect.acquireUseRelease(
		Effect.tryPromise({
			try: async () => {
				try {
					return await open(lockPath, "wx")
				} catch (cause) {
					if (!isErrorCode(cause, "EEXIST")) throw cause
					let stale = false
					try {
						stale = Date.now() - (await stat(lockPath)).mtimeMs >= lockTimeoutMs
					} catch (statCause) {
						if (!isErrorCode(statCause, "ENOENT")) throw statCause
					}
					if (!options.force && !stale) throw cause
					await rm(lockPath, { force: true })
					return open(lockPath, "wx")
				}
			},
			catch: (cause) =>
				new WorktreeLockError({
					message: `Another worktree operation is in progress for '${target.taskId}${target.phaseId ? `/${target.phaseId}` : ""}'. Retry with --force or remove the stale sentinel with: ${removalCommand}`,
					cause,
				}),
		}),
		() => effect,
		(lock) =>
			Effect.promise(async () => {
				let ownsLock = false
				try {
					const [held, current] = await Promise.all([
						lock.stat(),
						stat(lockPath),
					])
					ownsLock = held.dev === current.dev && held.ino === current.ino
				} catch {}
				await lock.close().catch(() => undefined)
				if (ownsLock) await rm(lockPath, { force: true }).catch(() => undefined)
			}),
	)
}

export const withWorktreeLocks = <A, E, R>(
	root: string,
	targets: readonly WorktreeLockTarget[],
	effect: Effect.Effect<A, E, R>,
	options: WorktreeLockOptions = {},
): Effect.Effect<A, E | WorktreeLockError, R> => {
	const unique = new Map(
		targets.map((target) => [
			`${target.taskId}:${target.phaseId ?? "task"}`,
			target,
		]),
	)
	let current: Effect.Effect<A, E | WorktreeLockError, R> = effect
	for (const [, target] of [...unique.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.reverse()) {
		current = withWorktreeLock(root, target, current, options)
	}
	return current
}
