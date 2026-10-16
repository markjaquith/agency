import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { join } from "node:path"
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
}

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
		const entry = {
			key: "/work:execution-unit:task/alpha",
			workbase: "/work",
			fingerprint: "abc",
			evaluatedAt: "2026-10-16T00:00:00.000Z",
			assessment,
		}
		const cache = await withState((state) =>
			state
				.writeTriageCache([entry], env)
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
})
