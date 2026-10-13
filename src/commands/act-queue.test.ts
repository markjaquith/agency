import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import type { GraphNode } from "../graph-schema"
import type { WorkStatus } from "../workbase/schemas"
import { applyOptimistic, makeActionQueue } from "./act-queue"

interface Payload {
	readonly name: string
	readonly gate: Deferred.Deferred<string, Error>
}

const harness = () => {
	const started: { name: string; revision: string }[] = []
	let changes = 0
	const queue = makeActionQueue<Payload>(() => changes++)
	const fiber = Effect.runFork(
		queue.worker((payload, revision) =>
			Effect.gen(function* () {
				started.push({ name: payload.name, revision })
				return yield* Deferred.await(payload.gate)
			}),
		),
	)
	const enqueue = (
		name: string,
		itemId: string,
		status: WorkStatus = "dropped",
		revision = `${itemId}@0`,
	) => {
		const gate = Effect.runSync(Deferred.make<string, Error>())
		const result = queue.enqueue({
			itemId,
			label: name,
			status,
			payload: { name, gate },
			revision,
			snapshot: 0,
			seen: queue.sequence,
		})
		if ("error" in result) throw new Error(result.error)
		return {
			job: result.job,
			succeed: (next: string) => Effect.runSync(Deferred.succeed(gate, next)),
			fail: (message: string) =>
				Effect.runSync(Deferred.fail(gate, new Error(message))),
		}
	}
	return {
		queue,
		started,
		enqueue,
		get changes() {
			return changes
		},
		settle: () => Bun.sleep(10),
		stop: () => Effect.runPromise(Fiber.interrupt(fiber)),
	}
}

const states = (queue: ReturnType<typeof harness>["queue"]) =>
	queue.jobs.map((job) => `${job.label}:${job.state}`)

describe("act action queue", () => {
	test("runs actions serially in FIFO order across items", async () => {
		const run = harness()
		try {
			const a = run.enqueue("a", "task:a")
			const b = run.enqueue("b", "task:b")
			const c = run.enqueue("c", "phase:c/one")
			await run.settle()
			expect(run.started.map((job) => job.name)).toEqual(["a"])
			expect(states(run.queue)).toEqual(["a:running", "b:pending", "c:pending"])
			b.succeed("task:b@1")
			await run.settle()
			expect(run.started.map((job) => job.name)).toEqual(["a"])
			a.succeed("task:a@1")
			await run.settle()
			c.succeed("phase:c/one@1")
			await run.settle()
			expect(run.started.map((job) => job.name)).toEqual(["a", "b", "c"])
			expect(states(run.queue)).toEqual(["a:done", "b:done", "c:done"])
			expect(run.queue.busy).toBe(false)
			expect(run.changes).toBeGreaterThan(0)
		} finally {
			await run.stop()
		}
	})

	test("applies queued statuses optimistically until a newer snapshot loads", async () => {
		const run = harness()
		try {
			const a = run.enqueue("drop a", "task:a", "dropped")
			run.enqueue("finish b", "task:b", "done")
			expect(run.queue.overlay(0)).toEqual([
				{ itemId: "task:a", status: "dropped" },
				{ itemId: "task:b", status: "done" },
			])
			await run.settle()
			a.succeed("task:a@1")
			await run.settle()
			expect(run.queue.overlay(0)).toContainEqual({
				itemId: "task:a",
				status: "dropped",
			})
			expect(run.queue.overlay(run.queue.sequence)).toEqual([
				{ itemId: "task:b", status: "done" },
			])
		} finally {
			await run.stop()
		}
	})

	test("bases later actions on an item on the earlier action's result", async () => {
		const run = harness()
		try {
			const drop = run.enqueue("drop", "task:a", "dropped")
			const reopen = run.enqueue("reopen", "task:a", "open")
			expect(reopen.job.after).toBe(drop.job.id)
			expect(run.queue.overlay(0).at(-1)).toEqual({
				itemId: "task:a",
				status: "open",
			})
			await run.settle()
			drop.succeed("task:a@dropped")
			await run.settle()
			reopen.succeed("task:a@open")
			await run.settle()
			expect(run.started).toEqual([
				{ name: "drop", revision: "task:a@0" },
				{ name: "reopen", revision: "task:a@dropped" },
			])
			expect(
				run.queue.basis("task:a", "task:a@0", 0, run.queue.sequence),
			).toEqual({ revision: "task:a@open" })
		} finally {
			await run.stop()
		}
	})

	test("rolls back a failed action and invalidates later actions on that item", async () => {
		const run = harness()
		try {
			const drop = run.enqueue("drop a", "task:a", "dropped")
			run.enqueue("reopen a", "task:a", "open")
			const other = run.enqueue("drop b", "task:b", "dropped")
			const seen = run.queue.sequence
			await run.settle()
			drop.fail("revision mismatch")
			await run.settle()
			expect(states(run.queue)).toEqual([
				"drop a:failed",
				"reopen a:cancelled",
				"drop b:running",
			])
			expect(run.queue.jobs[0]!.error).toBe("revision mismatch")
			expect(run.queue.jobs[1]!.error).toContain("drop a did not complete")
			expect(run.queue.overlay(0)).toEqual([
				{ itemId: "task:b", status: "dropped" },
			])
			expect(run.queue.visible.map((job) => job.state)).toEqual([
				"failed",
				"cancelled",
				"running",
			])
			expect(run.queue.basis("task:a", "task:a@0", 0, seen)).toEqual({
				error: "drop a did not complete; review the item before retrying",
			})
			expect(
				run.queue.basis("task:a", "task:a@0", 0, run.queue.sequence),
			).toEqual({ revision: "task:a@0" })
			other.succeed("task:b@1")
			await run.settle()
			expect(run.started.map((job) => job.name)).toEqual(["drop a", "drop b"])
		} finally {
			await run.stop()
		}
	})

	test("drains once every queued action settles", async () => {
		const run = harness()
		try {
			await Effect.runPromise(run.queue.drain)
			const a = run.enqueue("a", "task:a")
			let drained = false
			const waiting = Effect.runPromise(run.queue.drain).then(() => {
				drained = true
			})
			await run.settle()
			expect(drained).toBe(false)
			a.succeed("task:a@1")
			await waiting
			expect(drained).toBe(true)
		} finally {
			await run.stop()
		}
	})
})

const readiness = (status: WorkStatus) => ({
	ready: status === "open",
	blocked: status !== "open",
	blockedBy: status === "open" ? [] : ["task:a"],
	terminal: false,
	blockers:
		status === "open"
			? []
			: [
					{
						kind: "status" as const,
						id: "task:a",
						status,
						reason: `Task status is ${status}`,
					},
				],
})

const aggregate = (status: WorkStatus) => ({
	status,
	total: 1,
	open: 0,
	working: 0,
	delegated: 0,
	done: 0,
	dropped: 0,
	terminal: 0,
	[status]: 1,
})

const taskNodes = (status: WorkStatus) =>
	[
		{
			id: "task:a",
			kind: "task",
			key: "a",
			status,
			readiness: readiness(status),
			aggregate: aggregate(status),
			dependents: [],
			repositories: ["agency"],
			data: { status, sha256: "abc" },
		},
		{
			id: "execution-unit:task/a",
			kind: "execution-unit",
			key: "task/a",
			status,
			readiness: readiness(status),
			aggregate: aggregate(status),
			dependents: [],
			repositories: ["agency"],
			data: { taskId: "a", status },
		},
	] as unknown as readonly GraphNode[]

describe("optimistic graph state", () => {
	test("patches status, readiness, and the execution unit", () => {
		const nodes = taskNodes("working")
		expect(applyOptimistic(nodes, [])).toBe(nodes)
		const [entity, execution] = applyOptimistic(nodes, [
			{ itemId: "task:a", status: "dropped" },
		])
		for (const node of [entity!, execution!]) {
			expect(node.status).toBe("dropped")
			expect(node.readiness).toMatchObject({
				ready: false,
				terminal: true,
				blockers: [{ kind: "status", status: "dropped" }],
			})
			expect(node.data).toMatchObject({ status: "dropped" })
		}
		expect(entity!.data).toMatchObject({ sha256: "abc" })
		expect(nodes[0]!.status).toBe("working")
	})

	test("applies queued statuses in order and reopens to ready", () => {
		const [entity] = applyOptimistic(taskNodes("working"), [
			{ itemId: "task:a", status: "dropped" },
			{ itemId: "task:a", status: "open" },
		])
		expect(entity!.status).toBe("open")
		expect(entity!.readiness).toMatchObject({
			ready: true,
			blocked: false,
			terminal: false,
			blockers: [],
		})
	})
})
