import { Cause, Data, Effect, Exit, Option } from "effect"
import { lstat, mkdir, open, rename, rm } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import {
	documentRevision,
	RevisionConflictError,
} from "../workbase/document-revision"

class LifecycleTransactionError extends Data.TaggedError(
	"LifecycleTransactionError",
)<{
	readonly message: string
	readonly completed: readonly string[]
	readonly rolledBack: readonly string[]
	readonly manualRecovery: readonly string[]
	readonly cause?: unknown
}> {}

export interface TransactionStep<R = never> {
	readonly label: string
	readonly preflight?: Effect.Effect<void, unknown, R>
	readonly apply: Effect.Effect<void, unknown, R>
	readonly rollback?: Effect.Effect<void, unknown, R>
	readonly finalize?: Effect.Effect<void, unknown, R>
	readonly manualRecovery?: string
}

export const transactionEffect = <A>(run: () => PromiseLike<A>) =>
	Effect.uninterruptible(
		Effect.tryPromise({
			try: () => Promise.resolve(run()),
			catch: (cause) => cause,
		}),
	)

export const pathMustNotExistStep = (
	root: string,
	path: string,
	message: string,
): TransactionStep => ({
	label: `verify ${relative(root, path)} is available`,
	preflight: transactionEffect(async () => {
		if (await exists(path)) throw new Error(message)
	}),
	apply: Effect.void,
})

interface DocumentWrite {
	readonly path: string
	readonly content: string
	readonly create?: boolean
}

interface TransactionPlan<R> {
	readonly root: string
	readonly preconditions?: readonly {
		readonly path: string
		readonly revision: string
	}[]
	readonly steps: readonly TransactionStep<R>[]
}

const exists = async (path: string) => {
	try {
		await lstat(path)
		return true
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === "ENOENT"
		)
			return false
		throw error
	}
}

export const documentWriteStep = (
	root: string,
	writes: readonly DocumentWrite[],
): TransactionStep => {
	const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
	const stagingDirectory = join(root, `.agency-transaction-${token}`)
	const staged = writes.map((write, index) => ({
		...write,
		stage: join(stagingDirectory, `${index}.stage`),
		backup: join(stagingDirectory, `${index}.backup`),
	}))
	const installed: typeof staged = []
	const backedUp: typeof staged = []
	const createdDirectories: string[] = []
	const label = `install documents: ${writes
		.map((write) => relative(root, write.path))
		.join(", ")}`

	const rollback = async () => {
		for (const write of [...installed].reverse()) {
			await rm(write.path, { force: true })
		}
		for (const write of [...backedUp].reverse()) {
			if (await exists(write.backup)) await rename(write.backup, write.path)
		}
		for (const directory of [...createdDirectories].reverse()) {
			await rm(directory, { recursive: true, force: true })
		}
		installed.length = 0
		backedUp.length = 0
		createdDirectories.length = 0
	}

	return {
		label,
		preflight: transactionEffect(async () => {
			for (const write of staged) {
				const targetExists = await exists(write.path)
				if (write.create === true && targetExists)
					throw new Error(
						`Document already exists: ${relative(root, write.path)}`,
					)
				if (write.create !== true && !targetExists)
					throw new Error(
						`Document does not exist: ${relative(root, write.path)}`,
					)
			}
		}),
		apply: transactionEffect(async () => {
			await mkdir(stagingDirectory)
			for (const write of staged) await Bun.write(write.stage, write.content)
			try {
				for (const write of staged) {
					const parent = dirname(write.path)
					if (!(await exists(parent))) {
						await mkdir(parent, { recursive: true })
						createdDirectories.push(parent)
					}
					if (!write.create) {
						await rename(write.path, write.backup)
						backedUp.push(write)
					}
					try {
						await rename(write.stage, write.path)
					} catch (cause) {
						if (!write.create && (await exists(write.backup)))
							await rename(write.backup, write.path)
						throw cause
					}
					installed.push(write)
				}
			} catch (cause) {
				try {
					await rollback()
					await rm(stagingDirectory, { recursive: true, force: true })
				} catch (rollbackCause) {
					throw new LifecycleTransactionError({
						message: `Document installation failed and requires manual recovery: ${cause instanceof Error ? cause.message : String(cause)}`,
						completed: [label],
						rolledBack: [],
						manualRecovery: [
							`Inspect ${relative(root, stagingDirectory)} for staged documents and backups`,
						],
						cause: new AggregateError([cause, rollbackCause]),
					})
				}
				throw cause
			}
		}),
		rollback: transactionEffect(rollback),
		finalize: transactionEffect(async () => {
			await rm(stagingDirectory, { recursive: true, force: true })
		}),
		manualRecovery: `Inspect ${relative(root, stagingDirectory)} for staged documents and backups`,
	}
}

export const directoryMoveStep = (
	root: string,
	from: string,
	to: string,
): TransactionStep => {
	let createdParent = false
	return {
		label: `move ${relative(root, from)} to ${relative(root, to)}`,
		preflight: transactionEffect(async () => {
			if (!(await exists(from)))
				throw new Error(`Move source does not exist: ${relative(root, from)}`)
			if (await exists(to))
				throw new Error(
					`Move destination already exists: ${relative(root, to)}`,
				)
		}),
		apply: transactionEffect(async () => {
			const parent = dirname(to)
			if (!(await exists(parent))) {
				await mkdir(parent, { recursive: true })
				createdParent = true
			}
			await rename(from, to)
		}),
		rollback: transactionEffect(async () => {
			await rename(to, from)
			if (createdParent) await rm(dirname(to), { recursive: true, force: true })
		}),
		manualRecovery: `Move ${relative(root, to)} back to ${relative(root, from)}`,
	}
}

export const runLifecycleTransaction = <R>({
	root,
	preconditions = [],
	steps,
}: TransactionPlan<R>) =>
	Effect.uninterruptibleMask((restore) => {
		const lockPath = join(root, ".agency-graph-mutation.lock")
		return Effect.acquireUseRelease(
			Effect.tryPromise({
				try: () => open(lockPath, "wx"),
				catch: (cause) =>
					new LifecycleTransactionError({
						message:
							"Another graph mutation is in progress; wait for it to finish and retry",
						completed: [],
						rolledBack: [],
						manualRecovery: [],
						cause,
					}),
			}),
			() => {
				const completed: TransactionStep<R>[] = []
				const rolledBack: string[] = []
				const execute = Effect.gen(function* () {
					for (const precondition of preconditions) {
						const content = yield* restore(
							transactionEffect(() => Bun.file(precondition.path).text()),
						)
						const currentRevision = documentRevision(content as string)
						if (currentRevision !== precondition.revision) {
							return yield* new RevisionConflictError({
								path: relative(root, precondition.path),
								expectedRevision: precondition.revision,
								currentRevision,
								message: `Revision conflict for ${relative(root, precondition.path)}`,
							})
						}
					}
					for (const step of steps) {
						if (step.preflight) yield* restore(step.preflight)
					}
					for (const step of steps) {
						yield* restore(
							Effect.uninterruptibleMask((restoreStep) =>
								restoreStep(step.apply).pipe(
									Effect.tap(() => Effect.sync(() => completed.push(step))),
								),
							),
						)
					}
					const cleanup = yield* Effect.forEach(
						completed,
						(step) => Effect.exit(step.finalize ?? Effect.void),
						{ concurrency: "unbounded" },
					)
					const cleanupFailures = cleanup.filter(Exit.isFailure)
					if (cleanupFailures.length > 0) {
						return yield* new LifecycleTransactionError({
							message:
								"Lifecycle mutation completed, but transaction artifacts require manual cleanup",
							completed: completed.map((step) => step.label),
							rolledBack: [],
							manualRecovery: completed.flatMap((step) =>
								step.finalize && step.manualRecovery
									? [step.manualRecovery]
									: [],
							),
							cause: new AggregateError(
								cleanupFailures.map((result) => Cause.squash(result.cause)),
							),
						})
					}
				})

				return execute.pipe(
					Effect.catchAllCause((cause) =>
						Effect.gen(function* () {
							const failure = Option.getOrUndefined(Cause.failureOption(cause))
							if (failure instanceof LifecycleTransactionError)
								return yield* failure
							const rollbackErrors: unknown[] = []
							for (const step of [...completed].reverse()) {
								if (!step.rollback) continue
								const rollback = yield* Effect.exit(
									step.rollback.pipe(
										Effect.zipRight(step.finalize ?? Effect.void),
									),
								)
								if (Exit.isSuccess(rollback)) {
									rolledBack.push(step.label)
								} else {
									rollbackErrors.push(Cause.squash(rollback.cause))
								}
							}
							if (Cause.isInterruptedOnly(cause))
								return yield* Effect.failCause(cause as Cause.Cause<never>)
							const manualRecovery = completed
								.filter(
									(step) =>
										!rolledBack.includes(step.label) &&
										step.manualRecovery !== undefined,
								)
								.map((step) => step.manualRecovery!)
							if (failure instanceof RevisionConflictError)
								return yield* failure
							return yield* new LifecycleTransactionError({
								message:
									completed.length === 0
										? `Lifecycle mutation failed before changes were applied: ${failure instanceof Error ? failure.message : String(failure)}`
										: rollbackErrors.length
											? `Lifecycle mutation failed and rollback requires manual recovery: ${failure instanceof Error ? failure.message : String(failure)}`
											: `Lifecycle mutation failed; completed changes were rolled back: ${failure instanceof Error ? failure.message : String(failure)}`,
								completed: completed.map((step) => step.label),
								rolledBack,
								manualRecovery,
								cause: rollbackErrors.length
									? new AggregateError([Cause.squash(cause), ...rollbackErrors])
									: Cause.squash(cause),
							})
						}),
					),
				)
			},
			(lock) =>
				Effect.promise(async () => {
					await lock.close().catch(() => undefined)
					await rm(lockPath, { force: true }).catch(() => undefined)
				}),
		)
	})
