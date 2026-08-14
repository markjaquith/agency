import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { PushService } from "../services/PushService"
import { captureLogs } from "../test-utils"
import type { Progress } from "../utils/progress"
import { push } from "./push"

describe("push command", () => {
	test("reports deterministic progress while preserving one JSON result", async () => {
		const updates: string[] = []
		const progress: Progress = {
			start: (message) => updates.push(`start:${message}`),
			succeed: (message) => updates.push(`succeed:${message}`),
			fail: (message) => updates.push(`fail:${message}`),
		}
		const result = {
			vcs: "jj" as const,
			taskId: "example",
			branch: "task/example",
			base: "main",
			remote: "origin",
			tip: "abc123",
			changeId: "change",
		}
		const logs = await captureLogs(() =>
			Effect.runPromise(
				push({ cwd: "/workbase", json: true }, progress).pipe(
					Effect.provideService(PushService, {
						publish: (_cwd: string, options: any) => {
							for (const stage of [
								"context",
								"fetch",
								"inspect",
								"validate",
								"publish",
							] as const)
								options.onProgress(stage)
							return Effect.succeed(result)
						},
					} as never),
				) as Effect.Effect<void, unknown, never>,
			),
		)

		expect(logs).toEqual([JSON.stringify(result, null, 2)])
		expect(updates).toEqual([
			"start:Inspecting Agency execution context",
			"start:Fetching remote state",
			"start:Selecting the publication tip",
			"start:Validating outgoing changes",
			"start:Publishing the declared branch",
			"succeed:Published task/example to origin",
		])
	})
})
