import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { withWorktreeLocks } from "./WorktreeLock"

const createTempDir = () => mkdtemp(join(tmpdir(), "agency-lock-test-"))
const cleanupTempDir = (path: string) =>
	rm(path, { recursive: true, force: true })

describe("withWorktreeLocks", () => {
	const tempDirs: string[] = []

	afterEach(async () => {
		await Promise.all(tempDirs.splice(0).map(cleanupTempDir))
	})

	test("rejects a concurrent operation for the same target", async () => {
		const root = await createTempDir()
		tempDirs.push(root)
		let entered!: () => void
		let release!: () => void
		const enteredPromise = new Promise<void>((resolve) => {
			entered = resolve
		})
		const releasePromise = new Promise<void>((resolve) => {
			release = resolve
		})
		const held = Effect.runPromise(
			withWorktreeLocks(
				root,
				[{ taskId: "alpha" }],
				Effect.promise(async () => {
					entered()
					await releasePromise
				}),
			),
		)
		await enteredPromise

		const conflict = await Effect.runPromise(
			Effect.either(
				withWorktreeLocks(root, [{ taskId: "alpha" }], Effect.void),
			),
		)
		release()
		await held
		expect(conflict).toMatchObject({
			_tag: "Left",
			left: {
				_tag: "WorktreeLockError",
				message: "Another worktree operation is in progress for 'alpha'",
			},
		})
	})

	test("releases locks when the protected operation fails", async () => {
		const root = await createTempDir()
		tempDirs.push(root)
		const failure = new Error("operation failed")

		const result = await Effect.runPromise(
			Effect.either(
				withWorktreeLocks(
					root,
					[{ taskId: "alpha", phaseId: "build" }],
					Effect.fail(failure),
				),
			),
		)
		expect(result._tag).toBe("Left")
		if (result._tag === "Left") expect(result.left).toBe(failure)
		await expect(
			Effect.runPromise(
				withWorktreeLocks(
					root,
					[{ taskId: "alpha", phaseId: "build" }],
					Effect.succeed("reacquired"),
				),
			),
		).resolves.toBe("reacquired")
	})

	test("deduplicates targets while keeping task and phase locks distinct", async () => {
		const root = await createTempDir()
		tempDirs.push(root)
		let entered!: () => void
		let release!: () => void
		const enteredPromise = new Promise<void>((resolve) => {
			entered = resolve
		})
		const releasePromise = new Promise<void>((resolve) => {
			release = resolve
		})
		const held = Effect.runPromise(
			withWorktreeLocks(
				root,
				[
					{ taskId: "alpha" },
					{ taskId: "alpha" },
					{ taskId: "alpha", phaseId: "build" },
				],
				Effect.promise(async () => {
					entered()
					await releasePromise
				}),
			),
		)
		await enteredPromise

		expect(
			(await readdir(root)).filter((path) => path.endsWith(".lock")),
		).toHaveLength(2)

		release()
		await held
		expect(
			(await readdir(root)).filter((path) => path.endsWith(".lock")),
		).toEqual([])
	})
})
