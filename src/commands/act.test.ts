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
import type { Choice } from "../utils/chooser"
import { phase } from "./phase"
import { task } from "./task"
import { act, type ActInteraction } from "./act"

const scriptedInteraction = (
	selections: readonly (string | null)[],
	onSelect?: (prompt: string, choices: readonly Choice<unknown>[]) => void,
): ActInteraction => {
	let index = 0
	return {
		select: (prompt, choices) => {
			onSelect?.(prompt, choices)
			const selection = selections[index++] ?? null
			return Effect.succeed(
				selection === null
					? null
					: (choices.find((choice) => choice.value === selection)?.value ??
							null),
			)
		},
	}
}

describe("act command", () => {
	let root: string

	beforeEach(async () => {
		root = await createTempDir()
		await Bun.write(join(root, "agency.json"), '{"version":2}\n')
		const initialized = Bun.spawnSync([
			"git",
			"init",
			"--bare",
			join(root, "repos/agency"),
		])
		if (initialized.exitCode !== 0) {
			throw new Error(new TextDecoder().decode(initialized.stderr))
		}
	})

	afterEach(async () => cleanupTempDir(root))

	test("rejects non-interactive and empty invocations cleanly", async () => {
		await expect(
			runTestEffect(act({ cwd: root, inputAllowed: false })),
		).rejects.toThrow("requires interactive input")
		await expect(
			runTestEffect(
				act({ cwd: root, inputAllowed: true }, scriptedInteraction([])),
			),
		).rejects.toThrow("No active work items")
	})

	test("returns an empty target list as JSON without interactive input", async () => {
		const logs = await captureLogs(() =>
			runTestEffect(act({ cwd: root, inputAllowed: false, json: true })),
		)
		expect(JSON.parse(logs[0]!)).toEqual({ targets: [] })
	})

	test("cancellation exits without changing the selected item", async () => {
		await createTask("example")
		await runTestEffect(
			act({ cwd: root, inputAllowed: true }, scriptedInteraction([null])),
		)

		expect(await readTaskStatus("example")).toBe("open")
	})

	test("offers state-aware actions and dispatches drop through lifecycle semantics", async () => {
		await createTask("example")
		const offered: string[][] = []
		const logs = await captureLogs(() =>
			runTestEffect(
				act(
					{ cwd: root, inputAllowed: true },
					scriptedInteraction(["task:example", "drop"], (_prompt, choices) => {
						offered.push(choices.map((choice) => String(choice.value)))
					}),
				),
			),
		)

		expect(offered[1]).toEqual(["work", "pr", "drop"])
		expect(logs).toEqual(["Marked task 'example' as dropped"])
		expect(await readTaskStatus("example")).toBe("dropped")
	})

	test("accepts an explicit selector and prints dry-run command without mutation", async () => {
		await createTask("example")
		const prompts: string[] = []
		const logs = await captureLogs(() =>
			runTestEffect(
				act(
					{
						cwd: root,
						inputAllowed: true,
						taskId: "example",
						dryRun: true,
					},
					scriptedInteraction(["drop"], (prompt) => prompts.push(prompt)),
				),
			),
		)

		expect(prompts).toEqual(["Act on task example"])
		expect(logs).toEqual(["agency task status example dropped"])
		expect(await readTaskStatus("example")).toBe("open")
	})

	test("resolves a positional path and task ID without prompting for an item", async () => {
		await createTask("example")
		await mkdir(join(root, "tasks/example/code/agency"), { recursive: true })
		for (const options of [
			{ cwd: join(root, "tasks/example"), directory: "." },
			{ cwd: join(root, "tasks/example"), directory: "code/agency" },
			{ cwd: root, directory: "example" },
		]) {
			const prompts: string[] = []
			await runTestEffect(
				act(
					{ ...options, inputAllowed: true, dryRun: true, silent: true },
					scriptedInteraction(["drop"], (prompt) => prompts.push(prompt)),
				),
			)
			expect(prompts).toEqual(["Act on task example"])
		}
	})

	test("resolves a positional phase path without prompting for an item", async () => {
		await runTestEffect(
			task({
				subcommand: "create",
				args: ["multi"],
				multiPhase: true,
				cwd: root,
				silent: true,
			}),
		)
		await runTestEffect(
			phase({
				subcommand: "create",
				args: ["multi", "build"],
				repo: "agency",
				branch: "task/multi-build",
				base: "main",
				cwd: root,
				silent: true,
			}),
		)
		const prompts: string[] = []
		await runTestEffect(
			act(
				{
					cwd: join(root, "tasks/multi/phases/build"),
					directory: ".",
					inputAllowed: true,
					dryRun: true,
					silent: true,
				},
				scriptedInteraction(["drop"], (prompt) => prompts.push(prompt)),
			),
		)

		expect(prompts).toEqual(["Act on phase multi/build"])
	})

	test("orders owned items hierarchically and omits items without actions", async () => {
		await runTestEffect(
			task({
				subcommand: "create",
				args: ["multi"],
				multiPhase: true,
				cwd: root,
				silent: true,
			}),
		)
		await runTestEffect(
			phase({
				subcommand: "create",
				args: ["multi", "build"],
				repo: "agency",
				branch: "task/multi-build",
				base: "main",
				cwd: root,
				silent: true,
			}),
		)
		let choices: readonly Choice<unknown>[] = []
		await runTestEffect(
			act(
				{ cwd: root, inputAllowed: true },
				scriptedInteraction([null], (_prompt, offered) => {
					choices = offered
				}),
			),
		)

		expect(choices.map((choice) => [choice.value, choice.depth])).toEqual([
			["task:multi", 0],
			["phase:multi/build", 1],
		])
	})

	test("returns structured actions and argv for agents", async () => {
		await createTask("example")
		const logs = await captureLogs(() =>
			runTestEffect(
				act({
					cwd: root,
					inputAllowed: false,
					taskId: "example",
					json: true,
					auto: true,
					draft: true,
				}),
			),
		)

		expect(JSON.parse(logs[0]!)).toMatchObject({
			targets: [
				{
					kind: "task",
					key: "example",
					status: "open",
					actions: [
						{
							id: "work",
							command: ["agency", "work", "--task", "example", "--auto"],
						},
						{
							id: "pr",
							command: ["agency", "pr", "create", "example", "--draft"],
						},
						{
							id: "drop",
							command: ["agency", "task", "status", "example", "dropped"],
						},
					],
				},
			],
		})
	})

	test("offers reopen and archive for terminal work", async () => {
		await createTask("example")
		await runTestEffect(
			task({
				subcommand: "status",
				args: ["example", "dropped"],
				cwd: root,
				silent: true,
			}),
		)
		let actions: string[] = []
		await runTestEffect(
			act(
				{ cwd: root, inputAllowed: true },
				scriptedInteraction(["task:example", null], (prompt, choices) => {
					if (prompt.startsWith("Act on task")) {
						actions = choices.map((choice) => String(choice.value))
					}
				}),
			),
		)

		expect(actions).toEqual(["reopen", "archive"])
	})

	test("dispatches phase actions with the parent task identifier", async () => {
		await runTestEffect(
			task({
				subcommand: "create",
				args: ["multi"],
				multiPhase: true,
				cwd: root,
				silent: true,
			}),
		)
		await runTestEffect(
			phase({
				subcommand: "create",
				args: ["multi", "build"],
				repo: "agency",
				branch: "task/multi-build",
				base: "main",
				cwd: root,
				silent: true,
			}),
		)

		let actions: string[] = []
		await runTestEffect(
			act(
				{ cwd: root, inputAllowed: true, silent: true },
				scriptedInteraction(
					["phase:multi/build", "drop"],
					(prompt, choices) => {
						if (prompt.startsWith("Act on phase")) {
							actions = choices.map((choice) => String(choice.value))
						}
					},
				),
			),
		)

		expect(actions).toEqual(["work", "pr", "drop"])
		const content = await Bun.file(
			join(root, "tasks/multi/phases/build/PHASE.md"),
		).text()
		expect(content).toContain("status: dropped")
	})

	test("dispatches work and pull request actions through their command handlers", async () => {
		await createTask("example")
		const workCalls: unknown[] = []
		await runTestEffect(
			act(
				{ cwd: root, inputAllowed: true, auto: true },
				scriptedInteraction(["task:example", "work"]),
				((options) => {
					workCalls.push(options)
					return Effect.void
				}) as Parameters<typeof act>[2],
			),
		)
		expect(workCalls).toEqual([
			expect.objectContaining({
				taskId: "example",
				auto: true,
				cwd: root,
			}),
		])

		let prActionSeen = false
		await expect(
			runTestEffect(
				act(
					{ cwd: root, inputAllowed: true },
					{
						select: (prompt, choices) => {
							if (prompt.startsWith("Act on task")) {
								prActionSeen = choices.some((choice) => choice.value === "pr")
								return Effect.fail(new Error("stop before external PR command"))
							}
							return Effect.succeed(
								choices.find((choice) => choice.value === "task:example")
									?.value ?? null,
							)
						},
					},
				),
			),
		).rejects.toThrow("stop before external PR command")
		expect(prActionSeen).toBe(true)
	})

	test("rejects a stale selection before dispatch", async () => {
		await createTask("example")
		let selection = 0
		const interaction: ActInteraction = {
			select: (_prompt, choices) => {
				selection++
				if (selection === 1) {
					return Effect.succeed(
						choices.find((choice) => choice.value === "task:example")?.value ??
							null,
					)
				}
				return Effect.promise(async () => {
					await Bun.write(
						join(root, "tasks/example/TASK.md"),
						(
							await Bun.file(join(root, "tasks/example/TASK.md")).text()
						).replace("# Example", "# Example\n\nChanged after selection"),
					)
					return (
						choices.find((choice) => choice.value === "drop")?.value ?? null
					)
				})
			},
		}

		await expect(
			runTestEffect(act({ cwd: root, inputAllowed: true }, interaction)),
		).rejects.toThrow("Selected work item changed")
		expect(await readTaskStatus("example")).toBe("open")
	})

	const createTask = (id: string) =>
		runTestEffect(
			task({
				subcommand: "create",
				args: [id],
				repo: "agency",
				branch: `task/${id}`,
				base: "main",
				cwd: root,
				silent: true,
			}),
		)

	const readTaskStatus = async (id: string) => {
		const content = await Bun.file(join(root, `tasks/${id}/TASK.md`)).text()
		return content.match(/^status: (.+)$/m)?.[1]
	}
})
