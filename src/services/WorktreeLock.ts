import { Data, Effect } from "effect"
import { open, rm } from "node:fs/promises"
import { join } from "node:path"

class WorktreeLockError extends Data.TaggedError("WorktreeLockError")<{
	readonly message: string
	readonly cause?: unknown
}> {}

export interface WorktreeLockTarget {
	readonly taskId: string
	readonly phaseId?: string
}

const withWorktreeLock = <A, E, R>(
	root: string,
	target: WorktreeLockTarget,
	effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | WorktreeLockError, R> => {
	const key = Buffer.from(
		`${target.taskId}:${target.phaseId ?? "task"}`,
	).toString("hex")
	const lockPath = join(root, `.agency-worktree-${key}.lock`)
	const removalCommand = `rm '${lockPath.replaceAll("'", `'\\''`)}'`
	return Effect.acquireUseRelease(
		Effect.tryPromise({
			try: () => open(lockPath, "wx"),
			catch: (cause) =>
				new WorktreeLockError({
					message: `Another worktree operation is in progress for '${target.taskId}${target.phaseId ? `/${target.phaseId}` : ""}'. If no operation is active, remove the stale sentinel with: ${removalCommand}`,
					cause,
				}),
		}),
		() => effect,
		(lock) =>
			Effect.promise(async () => {
				await lock.close().catch(() => undefined)
				await rm(lockPath, { force: true }).catch(() => undefined)
			}),
	)
}

export const withWorktreeLocks = <A, E, R>(
	root: string,
	targets: readonly WorktreeLockTarget[],
	effect: Effect.Effect<A, E, R>,
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
		current = withWorktreeLock(root, target, current)
	}
	return current
}
