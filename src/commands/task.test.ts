import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { cleanupTempDir, createTempDir, runTestEffect } from "../test-utils"
import { task, type TaskInteraction } from "./task"

describe("task creation input", () => {
	let root: string

	beforeEach(async () => {
		root = await createTempDir()
		await Bun.write(join(root, "agency.json"), '{"version":2}\n')
		await mkdir(join(root, "repos/agency"), { recursive: true })
	})

	afterEach(async () => cleanupTempDir(root))

	test("guides task creation and defaults branch metadata", async () => {
		await mkdir(join(root, "epics/delivery"), { recursive: true })
		await Bun.write(
			join(root, "epics/delivery/EPIC.md"),
			"---\nticketUrl: https://example.com/delivery\nrepos:\n  - repo: agency\n    ref: main\ntasks: []\n---\n\n# Delivery\n",
		)
		const textAnswers = ["guided-task", "", ""]
		const prompts: string[] = []
		const interaction: TaskInteraction = {
			text: (prompt) => {
				prompts.push(prompt)
				return Effect.succeed(textAnswers.shift() ?? "")
			},
			select: (prompt, choices) => {
				prompts.push(`${prompt}: ${choices.join(",")}`)
				return Effect.succeed(
					prompt === "Parent epic"
						? "(none)"
						: prompt === "Task type"
							? "single-phase"
							: "agency",
				)
			},
		}

		await runTestEffect(
			task(
				{ subcommand: "new", args: [], cwd: root, silent: true },
				interaction,
			),
		)

		const content = await Bun.file(
			join(root, "tasks/guided-task/TASK.md"),
		).text()
		expect(content).toContain("ticketUrl: null")
		expect(content).toContain("repo: agency")
		expect(content).toContain("branch: task/guided-task")
		expect(content).toContain("base: main")
		expect(prompts).toEqual([
			"Task ID: ",
			"Ticket URL (optional): ",
			"Description (optional): ",
			"Parent epic: (none),delivery",
			"Task type: single-phase,multi-phase",
		])
	})

	test("asks for a repository only when more than one is available", async () => {
		await mkdir(join(root, "repos/web"), { recursive: true })
		const prompts: string[] = []
		const interaction: TaskInteraction = {
			text: () => Effect.fail(new Error("unexpected text prompt")),
			select: (prompt, choices) => {
				prompts.push(`${prompt}: ${choices.join(",")}`)
				return Effect.succeed(prompt === "Task type" ? "single-phase" : "web")
			},
		}

		await runTestEffect(
			task(
				{
					subcommand: "new",
					args: ["multi-repo"],
					ticketUrl: "",
					description: "",
					cwd: root,
					silent: true,
				},
				interaction,
			),
		)

		expect(prompts).toEqual([
			"Task type: single-phase,multi-phase",
			"Writable repository: agency,web",
		])
		expect(
			await Bun.file(join(root, "tasks/multi-repo/TASK.md")).text(),
		).toContain("repo: web")
	})

	test("keeps scripted creation non-interactive and permits no ticket URL", async () => {
		const interaction: TaskInteraction = {
			text: () => Effect.fail(new Error("unexpected text prompt")),
			select: () => Effect.fail(new Error("unexpected selection prompt")),
		}

		await runTestEffect(
			task(
				{
					subcommand: "create",
					args: ["scripted-task"],
					repo: "agency",
					cwd: root,
					silent: true,
				},
				interaction,
			),
		)

		const content = await Bun.file(
			join(root, "tasks/scripted-task/TASK.md"),
		).text()
		expect(content).toContain("ticketUrl: null")
		expect(content).toContain("branch: task/scripted-task")
		expect(content).toContain("base: main")
	})

	test("never prompts when scripted creation is incomplete", async () => {
		const interaction: TaskInteraction = {
			text: () => Effect.fail(new Error("unexpected text prompt")),
			select: () => Effect.fail(new Error("unexpected selection prompt")),
		}

		await expect(
			runTestEffect(
				task(
					{
						subcommand: "create",
						args: ["scripted-task"],
						cwd: root,
						silent: true,
					},
					interaction,
				),
			),
		).rejects.toThrow("Writable repository is required")
	})

	test("refuses guided creation when input is disabled", async () => {
		const interaction: TaskInteraction = {
			text: () => Effect.fail(new Error("unexpected text prompt")),
			select: () => Effect.fail(new Error("unexpected selection prompt")),
		}

		await expect(
			runTestEffect(
				task(
					{
						subcommand: "new",
						args: [],
						cwd: root,
						silent: true,
						inputAllowed: false,
					},
					interaction,
				),
			),
		).rejects.toThrow("task new requires interactive input")
	})
})
