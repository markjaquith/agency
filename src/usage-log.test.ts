import { afterEach, describe, expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { cleanupTempDir, createTempDir } from "./test-utils"
import { exportUsageEvents, recordUsageEvent } from "./usage-log"

describe("usage logging", () => {
	const tempDirs: string[] = []

	afterEach(() => Promise.all(tempDirs.splice(0).map(cleanupTempDir)))

	test("stores versioned privacy-safe events in session order", async () => {
		const state = await createTempDir()
		tempDirs.push(state)
		const env = {
			XDG_STATE_HOME: state,
			AGENCY_SESSION_ID: "session-1",
		} as NodeJS.ProcessEnv
		for (const commandPath of ["worktree/prepare", "context"]) {
			await recordUsageEvent(
				{
					commandPath,
					flagNames: ["json", "task", "json"],
					durationMs: 12.4,
					outcome: "success",
					exitStatus: 0,
				},
				"1.2.3",
				env,
			)
		}

		expect(await Bun.file(join(state, "agency/usage.sqlite3")).exists()).toBe(
			true,
		)
		expect(await exportUsageEvents(env)).toEqual([
			expect.objectContaining({
				version: 1,
				sessionId: "session-1",
				sessionSequence: 1,
				agencyVersion: "1.2.3",
				commandPath: "worktree/prepare",
				flagNames: ["json", "task"],
				durationMs: 12,
				outcome: "success",
				exitStatus: 0,
			}),
			expect.objectContaining({
				sessionSequence: 2,
				commandPath: "context",
			}),
		])
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
					exitStatus: 1,
				},
				"1.2.3",
				{ AGENCY_USAGE_DB: join(blocked, "usage.sqlite3") },
			),
		).resolves.toBeUndefined()
		await rm(blocked)
	})
})
