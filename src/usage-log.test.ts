import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { cleanupTempDir, createTempDir } from "./test-utils"
import {
	exportUsageEvents,
	recordUsageEvent,
	usageOutcomeCode,
} from "./usage-log"

describe("usage logging", () => {
	const tempDirs: string[] = []

	afterEach(() => Promise.all(tempDirs.splice(0).map(cleanupTempDir)))

	test("maps only reviewed failure categories", () => {
		expect(usageOutcomeCode({ _tag: "WorkbaseNotFoundError" })).toBe(
			"WORKBASE_NOT_FOUND",
		)
		expect(usageOutcomeCode({ _tag: "private-customer-id" })).toBe(
			"COMMAND_FAILED",
		)
	})

	test("stores versioned privacy-safe events in session order", async () => {
		const state = await createTempDir()
		tempDirs.push(state)
		const env = {
			XDG_STATE_HOME: state,
			AGENCY_SESSION_ID: "session-1",
			AGENCY_INVOCATION_SOURCE: "automation",
			AGENCY_USAGE_TEST: "1",
		} as NodeJS.ProcessEnv
		for (const commandPath of ["worktree/prepare", "context"]) {
			await recordUsageEvent(
				{
					commandPath,
					flagNames: ["json", "task", "json"],
					durationMs: 12.4,
					outcome: "success",
					outcomeCode: "SUCCESS",
					exitStatus: 0,
					...(commandPath === "context"
						? {
								vcs: "git" as const,
								terminalStage: "publish",
								category: "success",
							}
						: {}),
				},
				"1.2.3",
				env,
			)
		}

		expect(await Bun.file(join(state, "agency/usage.sqlite3")).exists()).toBe(
			true,
		)
		const events = await exportUsageEvents(env)
		expect(events).toEqual([
			expect.objectContaining({
				version: 2,
				journeyId: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
				journeySequence: 1,
				invocationSource: "automation",
				isTest: true,
				agencyVersion: "1.2.3",
				commandPath: "worktree/prepare",
				flagNames: ["json", "task"],
				durationMs: 12,
				outcome: "success",
				outcomeCode: "SUCCESS",
				exitStatus: 0,
			}),
			expect.objectContaining({
				journeySequence: 2,
				commandPath: "context",
				vcs: "git",
				terminalStage: "publish",
				category: "success",
			}),
		])
		expect(JSON.stringify(events)).not.toContain("session-1")
	})

	test("supports opt-out and ignores unavailable storage", async () => {
		const state = await createTempDir()
		tempDirs.push(state)
		const disabled = {
			XDG_STATE_HOME: state,
			AGENCY_NO_USAGE_LOG: "true",
		} as NodeJS.ProcessEnv
		await recordUsageEvent(
			{
				commandPath: "status",
				flagNames: [],
				durationMs: 1,
				outcome: "failure",
				outcomeCode: "COMMAND_FAILED",
				exitStatus: 1,
			},
			"1.2.3",
			disabled,
		)
		expect(await Bun.file(join(state, "agency/usage.sqlite3")).exists()).toBe(
			false,
		)

		const blocked = join(state, "blocked")
		await Bun.write(blocked, "not a directory")
		await expect(
			recordUsageEvent(
				{
					commandPath: "status",
					flagNames: [],
					durationMs: 1,
					outcome: "failure",
					outcomeCode: "COMMAND_FAILED",
					exitStatus: 1,
				},
				"1.2.3",
				{ AGENCY_USAGE_DB: join(blocked, "usage.sqlite3") },
			),
		).resolves.toBeUndefined()
		await rm(blocked)
	})

	test("prunes expired events on every database access", async () => {
		const state = await createTempDir()
		tempDirs.push(state)
		const env = {
			XDG_STATE_HOME: state,
			AGENCY_USAGE_RETENTION_DAYS: "30",
		} as NodeJS.ProcessEnv
		await recordUsageEvent(
			{
				commandPath: "status",
				flagNames: [],
				durationMs: 1,
				outcome: "success",
				outcomeCode: "SUCCESS",
				exitStatus: 0,
			},
			"1.2.3",
			env,
		)
		const database = new Database(join(state, "agency/usage.sqlite3"))
		database.run(
			"UPDATE usage_events SET occurred_at = datetime('now', '-31 days')",
		)
		database.close()

		expect(await exportUsageEvents(env)).toEqual([])
	})

	test("removes legacy events that may contain positional values", async () => {
		const state = await createTempDir()
		tempDirs.push(state)
		const path = join(state, "usage.sqlite3")
		const database = new Database(path, { create: true })
		database.run(
			"CREATE TABLE usage_events (id INTEGER PRIMARY KEY, command_path TEXT NOT NULL)",
		)
		database.run("INSERT INTO usage_events (command_path) VALUES (?)", [
			"task/private-customer-id",
		])
		database.close()
		const env = { AGENCY_USAGE_DB: path } as NodeJS.ProcessEnv

		await recordUsageEvent(
			{
				commandPath: "task/show",
				flagNames: [],
				durationMs: 1,
				outcome: "success",
				outcomeCode: "SUCCESS",
				exitStatus: 0,
			},
			"1.2.3",
			env,
		)

		expect(await exportUsageEvents(env)).toEqual([
			expect.objectContaining({ commandPath: "task/show", version: 2 }),
		])
	})
})
