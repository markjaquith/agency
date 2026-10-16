import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdir, readdir, utimes } from "node:fs/promises"
import { dirname, join } from "node:path"
import { cleanupTempDir, createTempDir, runTestEffect } from "../test-utils"
import { SupervisionStateService } from "./SupervisionStateService"

let tempDir: string
let env: NodeJS.ProcessEnv

beforeEach(async () => {
	tempDir = await createTempDir()
	env = { AGENCY_STATE_DIR: join(tempDir, "state") }
})

afterEach(async () => {
	await cleanupTempDir(tempDir)
})

const withState = <A, E>(
	use: (state: SupervisionStateService["Service"]) => Effect.Effect<A, E, any>,
) => runTestEffect(Effect.flatMap(SupervisionStateService, use))

const assessment = {
	status: "needs_input" as const,
	summary: "Waiting on a decision",
	question: "Which base?",
	actions: [],
	modelActionIds: [],
}

const cacheEntry = (key: string) => ({
	key,
	workbase: "/work",
	fingerprint: "abc",
	evaluatedAt: "2026-10-16T00:00:00.000Z",
	assessment,
})

describe("SupervisionStateService", () => {
	test("reads empty state when nothing is recorded", async () => {
		const state = await withState((state) =>
			Effect.all([
				state.triageCache(env),
				state.actions({}, env),
				state.snoozes(env),
				state.dismissals(env),
			]),
		)
		expect(state).toEqual([[], [], [], []])
	})

	test("persists the triage cache under the state directory", async () => {
		const entry = cacheEntry("/work:execution-unit:task/alpha")
		const cache = await withState((state) =>
			state
				.updateTriageCache(() => [entry], env)
				.pipe(Effect.andThen(state.triageCache(env))),
		)
		expect(cache).toEqual([entry])
		expect(
			await Bun.file(
				join(tempDir, "state/supervision/triage-cache.json"),
			).exists(),
		).toBe(true)
	})

	test("appends the action log and returns the most recent entries", async () => {
		const entries = await withState((state) =>
			Effect.gen(function* () {
				for (const id of ["a", "b", "c"]) {
					yield* state.appendAction(
						{
							key: "item",
							actionId: id,
							type: "runtime",
							title: id,
							outcome: "succeeded",
							detail: null,
						},
						env,
					)
				}
				return yield* state.actions({ limit: 2 }, env)
			}),
		)
		expect(entries.map((entry) => entry.actionId)).toEqual(["b", "c"])
		expect(entries[0]).toMatchObject({ version: 1, at: expect.any(String) })
	})

	test("replaces, expires, and removes snoozes", async () => {
		const snoozes = await withState((state) =>
			Effect.gen(function* () {
				yield* state.snooze(
					{
						key: "a",
						actionId: null,
						until: "2000-01-01T00:00:00Z",
						reason: null,
					},
					env,
				)
				yield* state.snooze(
					{
						key: "b",
						actionId: null,
						until: "2999-01-01T00:00:00Z",
						reason: null,
					},
					env,
				)
				yield* state.snooze(
					{
						key: "b",
						actionId: null,
						until: "2998-01-01T00:00:00Z",
						reason: "later",
					},
					env,
				)
				yield* state.snooze(
					{
						key: "c",
						actionId: "x",
						until: "2999-01-01T00:00:00Z",
						reason: null,
					},
					env,
				)
				yield* state.unsnooze({ key: "c", actionId: "x" }, env)
				return yield* state.snoozes(env)
			}),
		)
		expect(snoozes).toEqual([
			expect.objectContaining({
				key: "b",
				until: "2998-01-01T00:00:00Z",
				reason: "later",
			}),
		])
	})

	test("records and removes dismissals", async () => {
		const dismissals = await withState((state) =>
			Effect.gen(function* () {
				yield* state.dismiss(
					{ key: "a", actionId: null, fingerprint: "f1", reason: null },
					env,
				)
				yield* state.dismiss(
					{ key: "b", actionId: "x", fingerprint: null, reason: null },
					env,
				)
				yield* state.undismiss({ key: "b", actionId: "x" }, env)
				return yield* state.dismissals(env)
			}),
		)
		expect(dismissals).toEqual([
			expect.objectContaining({ key: "a", fingerprint: "f1" }),
		])
	})

	test("serializes concurrent cache updates so none is lost", async () => {
		const keys = Array.from({ length: 12 }, (_, index) => `item-${index}`)
		const cache = await withState((state) =>
			Effect.forEach(
				keys,
				(key) =>
					state.updateTriageCache(
						(current) => [...current, cacheEntry(key)],
						env,
					),
				{ concurrency: "unbounded" },
			).pipe(Effect.andThen(state.triageCache(env))),
		)
		expect(cache.map((entry) => entry.key).sort()).toEqual([...keys].sort())
		expect(
			(await readdir(join(tempDir, "state/supervision"))).filter(
				(name) => name.endsWith(".lock") || name.endsWith(".tmp"),
			),
		).toEqual([])
	})

	test("serializes concurrent snoozes and dismissals", async () => {
		const [snoozes, dismissals] = await withState((state) =>
			Effect.all(
				[
					...["a", "b", "c", "d"].map((key) =>
						state.snooze(
							{
								key,
								actionId: null,
								until: "2999-01-01T00:00:00Z",
								reason: null,
							},
							env,
						),
					),
					...["a", "b", "c", "d"].map((key) =>
						state.dismiss(
							{ key, actionId: null, fingerprint: null, reason: null },
							env,
						),
					),
				],
				{ concurrency: "unbounded" },
			).pipe(
				Effect.andThen(Effect.all([state.snoozes(env), state.dismissals(env)])),
			),
		)
		expect(snoozes).toHaveLength(4)
		expect(dismissals).toHaveLength(4)
	})

	test("breaks a stale lock", async () => {
		const lock = join(tempDir, "state/supervision/snoozes.lock")
		await mkdir(dirname(lock), { recursive: true })
		await Bun.write(lock, "999999\n")
		const old = new Date(Date.now() - 60_000)
		await utimes(lock, old, old)
		const snoozes = await withState((state) =>
			state
				.snooze(
					{
						key: "a",
						actionId: null,
						until: "2999-01-01T00:00:00Z",
						reason: null,
					},
					env,
				)
				.pipe(Effect.andThen(state.snoozes(env))),
		)
		expect(snoozes).toHaveLength(1)
	})

	test("compacts the action log to its newest entries", async () => {
		const path = join(tempDir, "state/supervision/actions.jsonl")
		await mkdir(dirname(path), { recursive: true })
		const line = (index: number) =>
			JSON.stringify({
				version: 1,
				at: "2026-10-16T00:00:00.000Z",
				key: null,
				actionId: `old-${index}`,
				type: "runtime",
				title: "x",
				outcome: "succeeded",
				detail: null,
			})
		await Bun.write(
			path,
			Array.from({ length: 1200 }, (_, index) => `${line(index)}\n`).join(""),
		)
		const entries = await withState((state) =>
			state
				.appendAction(
					{
						key: null,
						actionId: "new",
						type: "runtime",
						title: "x",
						outcome: "succeeded",
						detail: null,
					},
					env,
				)
				.pipe(Effect.andThen(state.actions({}, env))),
		)
		expect(entries).toHaveLength(1000)
		expect(entries.at(-1)!.actionId).toBe("new")
		expect(entries[0]!.actionId).toBe("old-201")
	})

	test("prunes dismissals", async () => {
		const dismissals = await withState((state) =>
			Effect.gen(function* () {
				for (const key of ["keep", "drop"])
					yield* state.dismiss(
						{ key, actionId: null, fingerprint: null, reason: null },
						env,
					)
				yield* state.pruneDismissals((entry) => entry.key === "keep", env)
				return yield* state.dismissals(env)
			}),
		)
		expect(dismissals.map((entry) => entry.key)).toEqual(["keep"])
	})
})
