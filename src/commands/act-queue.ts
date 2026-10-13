import { Cause, Effect, Exit } from "effect"
import type { GraphNode } from "../graph-schema"
import { aggregateProgress, isTerminalStatus } from "../readiness"
import type { WorkStatus } from "../workbase/schemas"

/** Item actions that change only status and can run in the background. */
export const queuedActionStatus: Readonly<Record<string, WorkStatus>> = {
	reopen: "open",
	drop: "dropped",
	complete: "done",
	"finish-review": "done",
}

type QueueJobState = "pending" | "running" | "done" | "failed" | "cancelled"

export interface QueueJob<J> {
	readonly id: number
	readonly itemId: string
	readonly label: string
	readonly status: WorkStatus
	readonly payload: J
	/** A job queued behind another job on the same item uses its result revision. */
	readonly after?: number
	readonly revision?: string
	readonly state: QueueJobState
	readonly error?: string
	readonly result?: string | null
	readonly settled?: number
}

export interface OptimisticStatus {
	readonly itemId: string
	readonly status: WorkStatus
}

interface EnqueueInput<J> {
	readonly itemId: string
	readonly label: string
	readonly status: WorkStatus
	readonly payload: J
	/** The item revision shown to the user when it was loaded. */
	readonly revision: string
	/** `sequence` when that revision was loaded. */
	readonly snapshot: number
	/** `sequence` when the optimistic state behind the choice was computed. */
	readonly seen: number
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

const message = (error: unknown) =>
	error instanceof Error
		? error.message
		: typeof error === "object" &&
			  error !== null &&
			  "message" in error &&
			  typeof error.message === "string"
			? error.message
			: String(error)

/**
 * A single serial FIFO of background item mutations. Jobs are applied
 * optimistically until they settle; a failed job rolls back its own change and
 * invalidates every later job on the same item, whose choices assumed it.
 */
export const makeActionQueue = <J>(onChange: () => void = () => {}) => {
	const jobs: Mutable<QueueJob<J>>[] = []
	const ready: Mutable<QueueJob<J>>[] = []
	let sequence = 0
	let nextId = 1
	let batchStart = 1
	let wake: (() => void) | undefined
	let idleWaiters: (() => void)[] = []
	const active = (job: QueueJob<J>) =>
		job.state === "pending" || job.state === "running"
	const busy = () => jobs.some(active)
	const notifyIdle = () => {
		if (busy()) return
		const waiters = idleWaiters
		idleWaiters = []
		for (const resolve of waiters) resolve()
	}
	const settle = (
		job: Mutable<QueueJob<J>>,
		state: "done" | "failed" | "cancelled",
		details: { error?: string; result?: string | null } = {},
	) => {
		job.state = state
		job.settled = ++sequence
		Object.assign(job, details)
	}
	const invalidateAfter = (failed: QueueJob<J>) => {
		for (const job of jobs)
			if (
				job.itemId === failed.itemId &&
				job.id > failed.id &&
				job.state === "pending"
			)
				settle(job, "cancelled", {
					error: `Skipped because ${failed.label} did not complete`,
				})
	}
	const next = Effect.callback<Mutable<QueueJob<J>>>((resume) => {
		const take = () => {
			const job = ready.shift()
			if (!job) return false
			wake = undefined
			resume(Effect.succeed(job))
			return true
		}
		if (!take()) wake = take
		return Effect.sync(() => {
			wake = undefined
		})
	})

	return {
		get sequence() {
			return sequence
		},
		get busy() {
			return busy()
		},
		/** The number of pending or running jobs. */
		get active() {
			return jobs.filter(active).length
		},
		get jobs(): readonly QueueJob<J>[] {
			return jobs
		},
		/** Jobs in the current batch that are still active or need attention. */
		get visible(): readonly QueueJob<J>[] {
			return jobs.filter((job) => job.id >= batchStart && job.state !== "done")
		},
		/**
		 * Optimistic statuses in FIFO order: unsettled jobs, plus completed jobs the
		 * snapshot loaded before they settled may not reflect yet.
		 */
		overlay: (snapshot: number): readonly OptimisticStatus[] =>
			jobs
				.filter(
					(job) =>
						active(job) || (job.state === "done" && job.settled! > snapshot),
				)
				.map(({ itemId, status }) => ({ itemId, status })),
		/**
		 * Resolve the revision a new choice on an item is based on: a pending job's
		 * result, a job completed after the snapshot, or the snapshot itself.
		 */
		basis,
		enqueue: (
			input: EnqueueInput<J>,
		): { readonly job: QueueJob<J> } | { readonly error: string } => {
			const resolved = basis(
				input.itemId,
				input.revision,
				input.snapshot,
				input.seen,
			)
			if ("error" in resolved) return resolved
			if (!busy()) batchStart = nextId
			const job: Mutable<QueueJob<J>> = {
				id: nextId++,
				itemId: input.itemId,
				label: input.label,
				status: input.status,
				payload: input.payload,
				...resolved,
				state: "pending",
			}
			jobs.push(job)
			ready.push(job)
			wake?.()
			onChange()
			return { job }
		},
		/** Resolve once no job is pending or running. */
		drain: Effect.callback<void>((resume) => {
			if (!busy()) return resume(Effect.void)
			const resolve = () => resume(Effect.void)
			idleWaiters.push(resolve)
			return Effect.sync(() => {
				idleWaiters = idleWaiters.filter((waiter) => waiter !== resolve)
			})
		}),
		/** Process jobs serially forever; `execute` returns the item's new revision. */
		worker: <R>(
			execute: (
				payload: J,
				revision: string,
			) => Effect.Effect<string | null, unknown, R>,
		): Effect.Effect<never, never, R> =>
			Effect.forever(
				Effect.gen(function* () {
					const job = yield* next
					if (job.state !== "pending") return
					const predecessor =
						job.after === undefined
							? undefined
							: jobs.find((candidate) => candidate.id === job.after)
					const revision =
						job.after === undefined
							? job.revision
							: predecessor?.state === "done" &&
								  typeof predecessor.result === "string"
								? predecessor.result
								: undefined
					if (revision === undefined) {
						settle(job, "cancelled", {
							error: `Skipped because ${predecessor?.label ?? "an earlier action"} did not complete`,
						})
					} else {
						job.state = "running"
						onChange()
						const exit = yield* Effect.exit(execute(job.payload, revision))
						if (Exit.isSuccess(exit))
							settle(job, "done", { result: exit.value })
						else {
							settle(job, "failed", {
								error: message(Cause.squash(exit.cause)),
							})
							invalidateAfter(job)
						}
					}
					onChange()
					notifyIdle()
				}),
			),
	}

	function basis(
		itemId: string,
		revision: string,
		snapshot: number,
		seen: number,
	):
		| { readonly after: number }
		| { readonly revision: string }
		| { readonly error: string } {
		const history = jobs.filter((job) => job.itemId === itemId)
		const invalidated = history.find(
			(job) =>
				(job.state === "failed" || job.state === "cancelled") &&
				job.settled! > seen,
		)
		if (invalidated)
			return {
				error: `${invalidated.label} did not complete; review the item before retrying`,
			}
		const last = history.at(-1)
		if (last && active(last)) return { after: last.id }
		const completed = history
			.filter((job) => job.state === "done" && job.settled! > snapshot)
			.at(-1)
		if (!completed) return { revision }
		return typeof completed.result === "string"
			? { revision: completed.result }
			: { error: `${completed.label} removed this item` }
	}
}

export type ActionQueue<J> = ReturnType<typeof makeActionQueue<J>>

type StatefulNode = Exclude<GraphNode, { readonly kind: "repository" }>

const withStatus = <N extends StatefulNode>(
	node: N,
	itemId: string,
	label: string,
	status: WorkStatus,
): N => {
	const blockers = node.readiness.blockers.filter(
		(blocker) => !(blocker.kind === "status" && blocker.id === itemId),
	)
	if (status !== "open")
		blockers.push({
			kind: "status",
			id: itemId,
			status,
			reason: `${label} status is ${status}`,
		})
	const ready = status === "open" && blockers.length === 0
	return {
		...node,
		status,
		aggregate: aggregateProgress([status]),
		readiness: {
			ready,
			blocked: !ready && blockers.length > 0,
			blockedBy: [...new Set(blockers.map((blocker) => blocker.id))].sort(),
			terminal: isTerminalStatus(status),
			blockers,
		},
		data: { ...node.data, status },
	}
}

/**
 * Apply queued status changes to a loaded graph for display and action
 * availability. Dependents' readiness refreshes after the next graph load.
 */
export const applyOptimistic = (
	nodes: readonly GraphNode[],
	overlay: readonly OptimisticStatus[],
): readonly GraphNode[] => {
	if (!overlay.length) return nodes
	const byId = new Map(nodes.map((node) => [node.id, node]))
	const touchedTasks = new Set<string>()
	for (const { itemId, status } of overlay) {
		const node = byId.get(itemId)
		if (!node || (node.kind !== "task" && node.kind !== "phase")) continue
		const label = node.kind === "phase" ? "Phase" : "Task"
		byId.set(itemId, withStatus(node, itemId, label, status))
		const executionId = `execution-unit:${node.kind}/${node.key}`
		const execution = byId.get(executionId)
		if (execution?.kind === "execution-unit")
			byId.set(executionId, withStatus(execution, itemId, label, status))
		if (node.kind === "phase")
			touchedTasks.add(`task:${node.key.slice(0, node.key.indexOf("/"))}`)
	}
	for (const taskId of touchedTasks) {
		const parent = byId.get(taskId)
		if (parent?.kind !== "task" || !("phases" in parent.data)) continue
		const aggregate = aggregateProgress(
			parent.data.phases.flatMap(({ id }) => {
				const phase = byId.get(`phase:${parent.key}/${id}`)
				return phase?.kind === "phase" ? [phase.status] : []
			}),
		)
		byId.set(taskId, {
			...parent,
			status: aggregate.status,
			aggregate,
			readiness: {
				...parent.readiness,
				terminal: isTerminalStatus(aggregate.status),
			},
		})
	}
	return nodes.map((node) => byId.get(node.id)!)
}
