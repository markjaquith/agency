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
import { parseCli } from "../cli-parser"
import { FileSystemService } from "../services/FileSystemService"
import { SyncService } from "../services/SyncService"

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

	test("rejects non-interactive input and allows cancellation in an empty workbase", async () => {
		await expect(
			runTestEffect(act({ cwd: root, inputAllowed: false })),
		).rejects.toThrow("requires interactive input")
		await runTestEffect(
			act({ cwd: root, inputAllowed: true }, scriptedInteraction([])),
		)
	})

	test("returns an empty target list as JSON without interactive input", async () => {
		const logs = await captureLogs(() =>
			runTestEffect(act({ cwd: root, inputAllowed: false, json: true })),
		)
		expect(JSON.parse(logs[0]!)).toMatchObject({
			targets: [],
			workbase: {
				actions: expect.arrayContaining([
					expect.objectContaining({ id: "task-create", command: null }),
					expect.objectContaining({ id: "repo-add" }),
				]),
			},
		})
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

		expect(offered[1]).toEqual([
			"work",
			"pr",
			"drop",
			"split",
			"complete",
			"sync",
		])
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
		expect(logs).toEqual([
			expect.stringMatching(
				/^agency task status example dropped --if-revision [a-f0-9]{64}$/,
			),
		])
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

		expect(
			choices
				.filter((choice) => choice.depth !== undefined)
				.map((choice) => [choice.value, choice.depth]),
		).toEqual([
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
					actions: expect.arrayContaining([
						expect.objectContaining({
							id: "work",
							command: ["agency", "work", "--task", "example", "--auto"],
						}),
						expect.objectContaining({
							id: "pr",
							command: ["agency", "pr", "create", "example", "--draft"],
						}),
						expect.objectContaining({
							id: "drop",
							command: [
								"agency",
								"task",
								"status",
								"example",
								"dropped",
								"--if-revision",
								expect.stringMatching(/^[a-f0-9]{64}$/),
							],
						}),
					]),
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

		expect(actions).toEqual(["reopen", "archive", "sync"])
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

		expect(actions).toEqual(["work", "pr", "drop", "complete", "sync"])
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

	test("action-first selection narrows targets and dispatches work once", async () => {
		await createTask("example")
		let calls = 0
		await runTestEffect(
			act(
				{ cwd: root, inputAllowed: true },
				scriptedInteraction(["action:work", "task:example"]),
				(() => {
					calls++
					return Effect.void
				}) as Parameters<typeof act>[2],
			),
		)
		expect(calls).toBe(1)
	})

	test("creates a task through guided input, including repository and purpose choices", async () => {
		const text = ["A useful outcome", "guided", ""]
		const logs = await captureLogs(() =>
			runTestEffect(
				act(
					{ cwd: root, action: "task-create", inputAllowed: true },
					{
						...scriptedInteraction(["investigation", "finish"]),
						text: () => Effect.succeed(text.shift() ?? null),
					},
				),
			),
		)
		expect(logs[0]).toContain("Created task 'guided'")
		const content = await Bun.file(join(root, "tasks/guided/TASK.md")).text()
		expect(content).toContain("purpose: investigation")
		expect(content).toContain("base: main")
		expect(content).toContain("A useful outcome")
		expect(
			await Bun.file(join(root, "tasks/guided/code/agency/.git")).exists(),
		).toBe(false)
	})

	test("repository and review previews quote inputs and never mutate", async () => {
		for (const [action, answers, selections, expected] of [
			[
				"repo-add",
				["new-repo", "https://example.com/a repo.git"],
				[],
				"agency repo add new-repo 'https://example.com/a repo.git'",
			],
			[
				"review",
				["https://github.com/org/repo/pull/9", "review-change"],
				[],
				"agency task create review-change --review agency --pull-request https://github.com/org/repo/pull/9",
			],
		] as const) {
			const values = [...answers]
			const logs = await captureLogs(() =>
				runTestEffect(
					act(
						{ cwd: root, action, dryRun: true, inputAllowed: true },
						{
							...scriptedInteraction(selections),
							text: () => Effect.succeed(values.shift() ?? null),
						},
					),
				),
			)
			expect(logs).toEqual([expected])
		}
		expect(
			await Bun.file(join(root, "tasks/review-change/TASK.md")).exists(),
		).toBe(false)
	})

	test("splits existing work and keeps branch ancestry separate from ordering", async () => {
		await createTask("example")
		const values = ["next", "first", "task/example", "task/example-next", ""]
		await runTestEffect(
			act(
				{
					cwd: root,
					taskId: "example",
					action: "split",
					silent: true,
					inputAllowed: true,
				},
				{
					...scriptedInteraction(["finish"]),
					text: () => Effect.succeed(values.shift() ?? null),
				},
			),
		)
		const content = await Bun.file(
			join(root, "tasks/example/phases/next/PHASE.md"),
		).text()
		expect(content).toContain("base: task/example")
		expect(content).not.toContain("dependsOn:")
		expect(
			await Bun.file(
				join(root, "tasks/example/phases/first/PHASE.md"),
			).exists(),
		).toBe(true)
	})

	test("creates a distinct linked implementation follow-up from investigation", async () => {
		await runTestEffect(
			task({
				subcommand: "create",
				args: ["investigate"],
				repo: "agency",
				purpose: "investigation",
				cwd: root,
				silent: true,
			}),
		)
		const before = await Bun.file(
			join(root, "tasks/investigate/TASK.md"),
		).text()
		const values = ["implement", ""]
		await runTestEffect(
			act(
				{
					cwd: root,
					taskId: "investigate",
					action: "handoff",
					silent: true,
					inputAllowed: true,
				},
				{
					...scriptedInteraction(["finish"]),
					text: () => Effect.succeed(values.shift() ?? null),
				},
			),
		)
		const content = await Bun.file(join(root, "tasks/implement/TASK.md")).text()
		expect(content).toContain("purpose: implementation")
		expect(content).toContain("taskId: investigate")
		expect(content).toContain("sourceRevision:")
		expect(await Bun.file(join(root, "tasks/investigate/TASK.md")).text()).toBe(
			before,
		)
	})

	test("completes a non-PR outcome with evidence and archives through lifecycle commands", async () => {
		await createTask("example")
		await runTestEffect(
			act(
				{
					cwd: root,
					taskId: "example",
					action: "complete",
					silent: true,
					inputAllowed: true,
				},
				{
					...scriptedInteraction([]),
					text: () => Effect.succeed("Investigation found no change needed"),
				},
			),
		)
		expect(await readTaskStatus("example")).toBe("done")
		expect(
			await Bun.file(join(root, "tasks/example/TASK.md")).text(),
		).toContain("Investigation found no change needed")
		await runTestEffect(
			act(
				{
					cwd: root,
					taskId: "example",
					action: "archive",
					silent: true,
					inputAllowed: true,
				},
				scriptedInteraction([]),
			),
		)
		expect(await Bun.file(join(root, "tasks/example/TASK.md")).exists()).toBe(
			false,
		)
	})

	test("rejects stale guided input and cancels without mutation", async () => {
		await createTask("example")
		await runTestEffect(
			act(
				{
					cwd: root,
					taskId: "example",
					action: "complete",
					inputAllowed: true,
				},
				{ ...scriptedInteraction([]), text: () => Effect.succeed(null) },
			),
		)
		expect(await readTaskStatus("example")).toBe("open")
		await expect(
			runTestEffect(
				act(
					{
						cwd: root,
						taskId: "example",
						action: "complete",
						inputAllowed: true,
					},
					{
						...scriptedInteraction([]),
						text: () =>
							Effect.promise(async () => {
								const path = join(root, "tasks/example/TASK.md")
								await Bun.write(
									path,
									(await Bun.file(path).text()) + "\nChanged during input\n",
								)
								return "Complete"
							}),
					},
				),
			),
		).rejects.toThrow("Selected work item changed")
		expect(await readTaskStatus("example")).toBe("open")
	})

	test("distinguishes provider refresh from GitHub mutations and their bookkeeping", async () => {
		await createTask("example")
		await runTestEffect(
			task({
				subcommand: "update",
				args: ["example"],
				prUrl: "https://github.com/org/repo/pull/9",
				cwd: root,
				silent: true,
			}),
		)
		for (const action of ["sync", "pr-ready", "pr-close"]) {
			const logs = await captureLogs(() =>
				runTestEffect(
					act(
						{
							cwd: root,
							taskId: "example",
							action,
							dryRun: true,
							inputAllowed: true,
						},
						scriptedInteraction([]),
					),
				),
			)
			expect(logs).toEqual(
				action === "sync"
					? ["agency sync example"]
					: [
							`agency pr ${action.slice(3)} https://github.com/org/repo/pull/9`,
							"agency sync example",
						],
			)
		}
		await expect(
			runTestEffect(
				act(
					{
						cwd: root,
						taskId: "example",
						action: "complete",
						inputAllowed: true,
					},
					scriptedInteraction([]),
				),
			),
		).rejects.toThrow("unavailable")
	})

	test("filtered discovery exposes current work, required inputs, and blocked reasons", async () => {
		await createTask("example")
		await runTestEffect(
			task({
				subcommand: "status",
				args: ["example", "working"],
				cwd: root,
				silent: true,
			}),
		)
		const logs = await captureLogs(() =>
			runTestEffect(
				act({ cwd: root, action: "handoff", json: true, inputAllowed: false }),
			),
		)
		const output = JSON.parse(logs[0]!)
		expect(output.currentWork[0]).toMatchObject({
			key: "example",
			repositories: ["agency"],
		})
		expect(output.targets[0].actions).toEqual([])
		expect(output.targets[0].blockedActions).toEqual([
			expect.objectContaining({
				id: "handoff",
				available: false,
				blockedReason: "Select an investigation execution unit",
			}),
		])
		const creationLogs = await captureLogs(() =>
			runTestEffect(act({ cwd: root, action: "task-create", json: true })),
		)
		const creation = JSON.parse(creationLogs[0]!)
		expect(creation.targets).toEqual([])
		expect(creation.workbase.actions).toHaveLength(1)
		expect(creation.workbase.actions[0]).toMatchObject({
			command: null,
			inputs: expect.arrayContaining([
				expect.objectContaining({ id: "id", required: true }),
			]),
		})
		expect(() =>
			parseCli(["act", "--action", "handoff", "--json"]),
		).not.toThrow()
		await expect(
			runTestEffect(act({ cwd: root, action: "typo", json: true })),
		).rejects.toThrow("Unknown action")
	})

	test("suggests safe IDs, skips the only repository, and works only after explicit selection", async () => {
		await createTask("new-outcome")
		const values = ["New outcome", "", ""]
		const prompts: string[] = []
		const workCalls: unknown[] = []
		await runTestEffect(
			act(
				{ cwd: root, action: "task-create", inputAllowed: true, silent: true },
				{
					...scriptedInteraction(["standard", "work"], (prompt) =>
						prompts.push(prompt),
					),
					text: (prompt) => {
						prompts.push(prompt)
						return Effect.succeed(values.shift() ?? null)
					},
				},
				((options) => {
					workCalls.push(options)
					return Effect.void
				}) as Parameters<typeof act>[2],
			),
		)
		expect(prompts).toContain("New task ID [new-outcome-2]: ")
		expect(prompts).not.toContain("Repository alias")
		expect(workCalls).toEqual([
			expect.objectContaining({ taskId: "new-outcome-2", cwd: root }),
		])
		expect(await readTaskStatus("new-outcome-2")).toBe("open")
	})

	test("GitHub mutation dispatch targets the recorded URL and reconciles only after success", async () => {
		await createTask("example")
		await runTestEffect(
			task({
				subcommand: "update",
				args: ["example"],
				prUrl: "https://github.com/org/repo/pull/9",
				cwd: root,
				silent: true,
			}),
		)
		for (const exitCode of [0, 3]) {
			const calls: string[] = []
			await expect(
				runTestEffect(
					Effect.gen(function* () {
						const fs = yield* FileSystemService
						const sync = yield* SyncService
						yield* act(
							{
								cwd: root,
								taskId: "example",
								action: "pr-ready",
								silent: true,
								inputAllowed: true,
							},
							scriptedInteraction([]),
						).pipe(
							Effect.provideService(FileSystemService, {
								...fs,
								runCommand: (args, options) => {
									if (args[0] !== "gh") return fs.runCommand(args, options)
									calls.push(args.join(" "))
									return Effect.succeed({ exitCode, stdout: "", stderr: "" })
								},
							}),
							Effect.provideService(SyncService, {
								...sync,
								reconcile: () => {
									calls.push("sync")
									return Effect.fail(new Error("reconciled after mutation"))
								},
							}),
						)
					}),
				),
			).rejects.toThrow(
				exitCode ? "GitHub PR ready failed (3)" : "reconciled after mutation",
			)
			expect(calls).toEqual([
				"gh pr ready https://github.com/org/repo/pull/9",
				...(exitCode ? [] : ["sync"]),
			])
		}
	})

	test("phase investigation handoff Work targets the new task without leaking source selectors", async () => {
		await runTestEffect(
			task({
				subcommand: "create",
				args: ["research"],
				multiPhase: true,
				purpose: "investigation",
				cwd: root,
				silent: true,
			}),
		)
		await runTestEffect(
			phase({
				subcommand: "create",
				args: ["research", "findings"],
				repo: "agency",
				branch: "task/research-findings",
				base: "main",
				cwd: root,
				silent: true,
			}),
		)
		const workCalls: unknown[] = []
		await runTestEffect(
			act(
				{
					cwd: root,
					directory: "tasks/research/phases/findings",
					action: "handoff",
					inputAllowed: true,
					silent: true,
				},
				{
					...scriptedInteraction(["work"]),
					text: () => Effect.succeed(""),
				},
				((options) => {
					workCalls.push(options)
					return Effect.void
				}) as Parameters<typeof act>[2],
			),
		)
		expect(workCalls).toEqual([
			{
				taskId: "research-implementation",
				cwd: root,
				auto: undefined,
				inputAllowed: true,
				silent: true,
				verbose: undefined,
			},
		])
		const content = await Bun.file(
			join(root, "tasks/research-implementation/TASK.md"),
		).text()
		expect(content).toContain("phaseId: findings")
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
