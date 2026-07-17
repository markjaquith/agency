import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import {
	captureLogs,
	cleanupTempDir,
	createTempDir,
	runTestEffect,
} from "../test-utils"
import { FileSystemService } from "../services/FileSystemService"
import { WorkbaseService } from "../services/WorkbaseService"
import type { PickWorkbase } from "../workbase/workbase-choice"
import { validate } from "./validate"

describe("validate command", () => {
	let root: string

	beforeEach(async () => {
		root = await createTempDir()
		await Bun.write(join(root, "agency.json"), '{"version":2}\n')
		await mkdir(join(root, "repos/agency"), { recursive: true })
		await mkdir(join(root, "tasks/example"), { recursive: true })
	})

	afterEach(async () => {
		await cleanupTempDir(root)
	})

	test("succeeds for a valid workbase", async () => {
		await Bun.write(
			join(root, "tasks/example/TASK.md"),
			`---
ticketUrl: https://example.com/tasks/example
repo: agency
branch: task/example
base: main
pr: null
---

# Example
`,
		)

		await expect(
			runTestEffect(validate({ cwd: root, silent: true })),
		).resolves.toBeUndefined()
	})

	test("validates an explicit workbase path", async () => {
		await Bun.write(
			join(root, "tasks/example/TASK.md"),
			`---
ticketUrl: null
repo: agency
branch: task/example
base: main
pr: null
---
`,
		)

		await expect(
			runTestEffect(
				validate({ path: root, cwd: join(root, "outside"), silent: true }),
			),
		).resolves.toBeUndefined()
	})

	test("selects a registered workbase when local discovery fails", async () => {
		const discovered: string[] = []
		const workbase = {
			discover: (path: string) => {
				discovered.push(path)
				return path === "/outside"
					? Effect.fail({
							_tag: "WorkbaseNotFoundError" as const,
							message: "No Agency workbase found from /outside",
						})
					: Effect.succeed(path)
			},
			listRegistered: () => Effect.succeed(["/first", "/selected"]),
			getDefault: () => Effect.succeed(undefined),
			validate: (path: string) =>
				Effect.succeed({
					root: path,
					issues: [],
					epicCount: 0,
					taskCount: 0,
					phaseCount: 0,
					valid: true,
				}),
		}
		const fs = {
			runCommand: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
		}
		const pick: PickWorkbase = (workbases) => {
			expect(workbases).toEqual(["/first", "/selected"])
			return Effect.succeed("/selected")
		}

		await Effect.runPromise(
			validate({ cwd: "/outside", silent: true }, pick).pipe(
				Effect.provideService(WorkbaseService, workbase as never),
				Effect.provideService(FileSystemService, fs as never),
			) as Effect.Effect<void, unknown, never>,
		)

		expect(discovered).toEqual(["/outside", "/selected"])
	})

	test("does not select a registered workbase when input is disabled", async () => {
		const workbase = {
			discover: () =>
				Effect.fail({
					_tag: "WorkbaseNotFoundError" as const,
					message: "No Agency workbase found from /outside",
				}),
			listRegistered: () => Effect.succeed(["/selected"]),
			getDefault: () => Effect.succeed(undefined),
		}
		const fs = {
			runCommand: () => Effect.fail(new Error("unexpected fzf probe")),
		}
		const pick: PickWorkbase = () =>
			Effect.fail(new Error("unexpected workbase selection"))

		await expect(
			Effect.runPromise(
				validate(
					{ cwd: "/outside", silent: true, inputAllowed: false },
					pick,
				).pipe(
					Effect.provideService(WorkbaseService, workbase as never),
					Effect.provideService(FileSystemService, fs as never),
				) as Effect.Effect<void, unknown, never>,
			),
		).rejects.toThrow("provide an explicit path or run Agency from a workbase")
	})

	test("outputs the validation report as JSON", async () => {
		await Bun.write(
			join(root, "tasks/example/TASK.md"),
			`---
ticketUrl: https://example.com/tasks/example
repo: agency
branch: task/example
base: main
pr: null
---
`,
		)
		const logs = await captureLogs(() =>
			runTestEffect(validate({ cwd: root, json: true })),
		)

		expect(JSON.parse(logs[0]!)).toEqual({
			root,
			issues: [],
			epicCount: 0,
			taskCount: 1,
			phaseCount: 0,
			valid: true,
		})
	})

	test("fails with document diagnostics", async () => {
		await Bun.write(
			join(root, "tasks/example/TASK.md"),
			`---
ticketUrl: https://example.com/tasks/example
repo: missing
branch: task/example
base: main
pr: null
---

# Example
`,
		)

		await expect(
			runTestEffect(validate({ cwd: root, silent: true })),
		).rejects.toThrow("Unknown repository alias 'missing'")
	})
})
