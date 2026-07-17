import { Data, Effect } from "effect"
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

export interface TransactionStep {
	readonly label: string
	readonly preflight?: () => Promise<void>
	readonly apply: () => Promise<void>
	readonly rollback?: () => Promise<void>
	readonly finalize?: () => Promise<void>
	readonly manualRecovery?: string
}

interface DocumentWrite {
	readonly path: string
	readonly content: string
	readonly create?: boolean
}

interface TransactionPlan {
	readonly root: string
	readonly preconditions?: readonly {
		readonly path: string
		readonly revision: string
	}[]
	readonly steps: readonly TransactionStep[]
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
		preflight: async () => {
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
		},
		apply: async () => {
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
		},
		rollback,
		finalize: async () => {
			await rm(stagingDirectory, { recursive: true, force: true })
		},
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
		preflight: async () => {
			if (!(await exists(from)))
				throw new Error(`Move source does not exist: ${relative(root, from)}`)
			if (await exists(to))
				throw new Error(
					`Move destination already exists: ${relative(root, to)}`,
				)
		},
		apply: async () => {
			const parent = dirname(to)
			if (!(await exists(parent))) {
				await mkdir(parent, { recursive: true })
				createdParent = true
			}
			await rename(from, to)
		},
		rollback: async () => {
			await rename(to, from)
			if (createdParent) await rm(dirname(to), { recursive: true, force: true })
		},
		manualRecovery: `Move ${relative(root, to)} back to ${relative(root, from)}`,
	}
}

export const runLifecycleTransaction = ({
	root,
	preconditions = [],
	steps,
}: TransactionPlan) =>
	Effect.tryPromise({
		try: async () => {
			const lockPath = join(root, ".agency-graph-mutation.lock")
			let lock: Awaited<ReturnType<typeof open>>
			try {
				lock = await open(lockPath, "wx")
			} catch (cause) {
				throw new LifecycleTransactionError({
					message:
						"Another graph mutation is in progress; wait for it to finish and retry",
					completed: [],
					rolledBack: [],
					manualRecovery: [],
					cause,
				})
			}

			const completed: TransactionStep[] = []
			const rolledBack: string[] = []
			try {
				for (const precondition of preconditions) {
					const content = await Bun.file(precondition.path).text()
					const currentRevision = documentRevision(content)
					if (currentRevision !== precondition.revision) {
						throw new RevisionConflictError({
							path: relative(root, precondition.path),
							expectedRevision: precondition.revision,
							currentRevision,
							message: `Revision conflict for ${relative(root, precondition.path)}`,
						})
					}
				}
				for (const step of steps) await step.preflight?.()
				for (const step of steps) {
					await step.apply()
					completed.push(step)
				}
				const cleanup = await Promise.allSettled(
					completed.map((step) => step.finalize?.() ?? Promise.resolve()),
				)
				const cleanupFailures = cleanup.filter(
					(result) => result.status === "rejected",
				)
				if (cleanupFailures.length > 0) {
					throw new LifecycleTransactionError({
						message:
							"Lifecycle mutation completed, but transaction artifacts require manual cleanup",
						completed: completed.map((step) => step.label),
						rolledBack: [],
						manualRecovery: completed.flatMap((step) =>
							step.finalize && step.manualRecovery ? [step.manualRecovery] : [],
						),
						cause: new AggregateError(
							cleanupFailures.map((result) =>
								result.status === "rejected" ? result.reason : undefined,
							),
						),
					})
				}
			} catch (cause) {
				if (cause instanceof LifecycleTransactionError) throw cause
				const rollbackErrors: unknown[] = []
				for (const step of [...completed].reverse()) {
					if (!step.rollback) continue
					try {
						await step.rollback()
						rolledBack.push(step.label)
						await step.finalize?.()
					} catch (error) {
						rollbackErrors.push(error)
					}
				}
				const manualRecovery = completed
					.filter(
						(step) =>
							!rolledBack.includes(step.label) &&
							step.manualRecovery !== undefined,
					)
					.map((step) => step.manualRecovery!)
				throw new LifecycleTransactionError({
					message:
						completed.length === 0
							? `Lifecycle mutation failed before changes were applied: ${cause instanceof Error ? cause.message : String(cause)}`
							: rollbackErrors.length
								? `Lifecycle mutation failed and rollback requires manual recovery: ${cause instanceof Error ? cause.message : String(cause)}`
								: `Lifecycle mutation failed; completed changes were rolled back: ${cause instanceof Error ? cause.message : String(cause)}`,
					completed: completed.map((step) => step.label),
					rolledBack,
					manualRecovery,
					cause: rollbackErrors.length
						? new AggregateError([cause, ...rollbackErrors])
						: cause,
				})
			} finally {
				await lock.close().catch(() => undefined)
				await rm(lockPath, { force: true }).catch(() => undefined)
			}
		},
		catch: (cause) =>
			cause instanceof LifecycleTransactionError ||
			cause instanceof RevisionConflictError
				? cause
				: new LifecycleTransactionError({
						message: "Lifecycle mutation failed before changes were applied",
						completed: [],
						rolledBack: [],
						manualRecovery: [],
						cause,
					}),
	})
