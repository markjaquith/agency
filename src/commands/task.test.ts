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

	test("resolves a configured branch name when creation omits --branch", async () => {
		await Bun.write(
			join(root, "agency.json"),
			JSON.stringify({
				version: 2,
				branchNameCommand: [
					"sh",
					"-c",
					'printf "%s" "$1"',
					"resolver",
					"custom/{repo}/{ticket}",
				],
			}),
		)

		await runTestEffect(
			task({
				subcommand: "create",
				args: ["configured"],
				repo: "agency",
				cwd: root,
				silent: true,
			}),
		)

		expect(
			await Bun.file(join(root, "tasks/configured/TASK.md")).text(),
		).toContain("branch: custom/agency/configured")
	})

	test("fails immediately when the configured resolver fails or returns an invalid ref", async () => {
		await Bun.write(
			join(root, "agency.json"),
			JSON.stringify({
				version: 2,
				branchNameCommand: ["sh", "-c", "echo resolver-error >&2; exit 7"],
			}),
		)
		await expect(
			runTestEffect(
				task({
					subcommand: "create",
					args: ["failed"],
					repo: "agency",
					cwd: root,
					silent: true,
				}),
			),
		).rejects.toThrow(
			"branchNameCommand failed with exit code 7: resolver-error",
		)

		await Bun.write(
			join(root, "agency.json"),
			JSON.stringify({
				version: 2,
				branchNameCommand: ["sh", "-c", "printf 'bad branch'"],
			}),
		)
		await expect(
			runTestEffect(
				task({
					subcommand: "create",
					args: ["invalid"],
					repo: "agency",
					cwd: root,
					silent: true,
				}),
			),
		).rejects.toThrow("produced invalid Git branch name 'bad branch'")

		await Bun.write(
			join(root, "agency.json"),
			JSON.stringify({
				version: 2,
				branchNameCommand: ["sh", "-c", "exit 0"],
			}),
		)
		await expect(
			runTestEffect(
				task({
					subcommand: "create",
					args: ["empty"],
					repo: "agency",
					cwd: root,
					silent: true,
				}),
			),
		).rejects.toThrow("produced an empty branch name")
	})

	test("lets an explicit --branch bypass the configured resolver", async () => {
		await Bun.write(
			join(root, "agency.json"),
			JSON.stringify({
				version: 2,
				branchNameCommand: ["sh", "-c", "exit 9"],
			}),
		)

		await runTestEffect(
			task({
				subcommand: "create",
				args: ["explicit"],
				repo: "agency",
				branch: "chosen/explicit",
				cwd: root,
				silent: true,
			}),
		)

		expect(
			await Bun.file(join(root, "tasks/explicit/TASK.md")).text(),
		).toContain("branch: chosen/explicit")
	})

	test("returns revision-bound validation evidence and normalized recalled context", async () => {
		const [output] = await captureLogs(() =>
			runTestEffect(
				task({
					subcommand: "create",
					args: ["scripted-context"],
					contextRepo: "agency",
					contextBase: "main",
					contextSlug: "scripted-context",
					authoritativeSources: [
						"https://example.com/spec",
						join(root, "SOURCE.md"),
					],
					cwd: root,
					json: true,
				}),
			),
		)
		const result = JSON.parse(output!)
		expect(result.selector).toBe("execution-unit:task/scripted-context")
		expect(result.documentPath).toBe(
			join(root, "tasks/scripted-context/TASK.md"),
		)
		expect(result.validation.valid).toBe(true)
		expect(result.evidence).toEqual(
			expect.objectContaining({
				version: 1,
				target: "execution-unit:task/scripted-context",
				documentRevision: result.revision,
				valid: true,
				digest: expect.any(String),
			}),
		)
		expect(result.recalledContext).toEqual({
			repo: "agency",
			base: "main",
			preferredSlug: "scripted-context",
			authoritativeSources: [
				join(root, "SOURCE.md"),
				"https://example.com/spec",
			],
		})
	})

	test("rejects stale or conflicting recalled context", async () => {
		await expect(
			runTestEffect(
				task({
					subcommand: "create",
					args: ["conflict"],
					repo: "agency",
					contextRepo: "other",
					cwd: root,
					silent: true,
				}),
			),
		).rejects.toThrow("conflicts with --repo")
		await expect(
			runTestEffect(
				task({
					subcommand: "create",
					args: ["conflict"],
					contextRepo: "agency",
					contextSlug: "stale-slug",
					cwd: root,
					silent: true,
				}),
			),
		).rejects.toThrow("conflicts with task ID")
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

	test("starts work on a newly created task", async () => {
		const launches: unknown[] = []

		await runTestEffect(
			task(
				{
					subcommand: "new",
					args: ["immediate"],
					ticketUrl: "",
					description: "",
					multiPhase: false,
					repo: "agency",
					work: true,
					auto: true,
					cwd: root,
					silent: true,
				},
				undefined,
				(options) =>
					Effect.sync(() => {
						launches.push(options)
						return undefined
					}),
			),
		)

		expect(launches).toEqual([
			expect.objectContaining({
				taskId: "immediate",
				auto: true,
				cwd: root,
			}),
		])
	})
})
