import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { join } from "node:path"
import { cleanupTempDir, createTempDir } from "../test-utils"
import {
	documentWriteStep,
	runLifecycleTransaction,
	transactionEffect,
} from "./LifecycleTransaction"

describe("lifecycle transactions", () => {
	let root: string

	beforeEach(async () => {
		root = await createTempDir()
	})

	afterEach(async () => cleanupTempDir(root))

	test("completes every preflight before applying the first step", async () => {
		const marker = join(root, "marker")
		await expect(
			Effect.runPromise(
				runLifecycleTransaction({
					root,
					steps: [
						{
							label: "write marker",
							apply: transactionEffect(async () => {
								await Bun.write(marker, "applied")
							}),
						},
						{
							label: "reject plan",
							preflight: Effect.sync(() => {
								throw new Error("preflight rejected")
							}),
							apply: Effect.void,
						},
					],
				}),
			),
		).rejects.toThrow("failed before changes were applied")
		expect(await Bun.file(marker).exists()).toBe(false)
	})

	test("installs document writes together and rolls them back together", async () => {
		const existing = join(root, "existing.md")
		const created = join(root, "nested", "created.md")
		await Bun.write(existing, "before")

		let failure: any
		const result = await Effect.runPromise(
			runLifecycleTransaction({
				root,
				steps: [
					documentWriteStep(root, [
						{ path: existing, content: "after" },
						{ path: created, content: "created", create: true },
					]),
					{
						label: "fail after documents",
						apply: Effect.sync(() => {
							throw new Error("injected failure")
						}),
					},
				],
			}).pipe(Effect.either),
		)
		if (result._tag === "Left") failure = result.left

		expect(failure.completed).toEqual([
			"install documents: existing.md, nested/created.md",
		])
		expect(failure.rolledBack).toEqual(failure.completed)
		expect(failure.manualRecovery).toEqual([])
		expect(await Bun.file(existing).text()).toBe("before")
		expect(await Bun.file(created).exists()).toBe(false)
	})

	test("reports completed and manually recoverable work when rollback fails", async () => {
		let failure: any
		const result = await Effect.runPromise(
			runLifecycleTransaction({
				root,
				steps: [
					{
						label: "external mutation",
						apply: Effect.void,
						rollback: Effect.sync(() => {
							throw new Error("rollback failed")
						}),
						manualRecovery: "undo external mutation",
					},
					{
						label: "injected failure",
						apply: Effect.sync(() => {
							throw new Error("apply failed")
						}),
					},
				],
			}).pipe(Effect.either),
		)
		if (result._tag === "Left") failure = result.left

		expect(failure.completed).toEqual(["external mutation"])
		expect(failure.rolledBack).toEqual([])
		expect(failure.manualRecovery).toEqual(["undo external mutation"])
	})

	test("waits for rollback and lock release when interrupted", async () => {
		const events: string[] = []
		const blocked = await Effect.runPromise(Deferred.make<void>())
		const fiber = Effect.runFork(
			runLifecycleTransaction({
				root,
				steps: [
					{
						label: "external mutation",
						apply: Effect.sync(() => events.push("applied")),
						rollback: transactionEffect(async () => {
							events.push("rollback started")
							await Bun.sleep(20)
							events.push("rollback finished")
						}),
					},
					{
						label: "block",
						apply: Deferred.succeed(blocked, undefined).pipe(
							Effect.zipRight(Effect.never),
						),
					},
				],
			}),
		)
		await Effect.runPromise(Deferred.await(blocked))

		await Effect.runPromise(Fiber.interrupt(fiber))

		expect(events).toEqual(["applied", "rollback started", "rollback finished"])
		expect(
			await Bun.file(join(root, ".agency-graph-mutation.lock")).exists(),
		).toBe(false)
	})
})
