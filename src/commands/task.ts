import { Effect } from "effect"
import { createInterface } from "node:readline/promises"
import type { BaseCommandOptions } from "../utils/command"
import { TaskService } from "../services/TaskService"
import { EpicService } from "../services/EpicService"
import { RepositoryService } from "../services/RepositoryService"
import { createLoggers } from "../utils/effect"
import { parseRepositoryReferences } from "../workbase/repository-reference"

interface TaskOptions extends BaseCommandOptions {
	readonly subcommand?: string
	readonly args: readonly string[]
	readonly ticketUrl?: string
	readonly description?: string
	readonly epic?: string
	readonly repo?: string
	readonly references?: readonly string[]
	readonly branch?: string
	readonly base?: string
	readonly multiPhase?: boolean
	readonly json?: boolean
}

export interface TaskInteraction {
	readonly text: (prompt: string) => Effect.Effect<string, Error>
	readonly select: (
		prompt: string,
		choices: readonly string[],
	) => Effect.Effect<string | null, Error>
}

const defaultInteraction: TaskInteraction = {
	text: (prompt) =>
		Effect.tryPromise({
			try: async () => {
				const input = createInterface({
					input: process.stdin,
					output: process.stderr,
				})
				try {
					return await input.question(prompt)
				} finally {
					input.close()
				}
			},
			catch: (cause) => new Error("Failed to read task input", { cause }),
		}),
	select: (prompt, choices) =>
		Effect.tryPromise({
			try: async () => {
				const process = Bun.spawn(
					["fzf", `--prompt=${prompt}> `, "--height=~40%", "--reverse"],
					{
						stdin: new Blob([choices.join("\n")]),
						stdout: "pipe",
						stderr: "inherit",
					},
				)
				const [exitCode, output] = await Promise.all([
					process.exited,
					new Response(process.stdout).text(),
				])
				if (exitCode === 1 || exitCode === 130) return null
				if (exitCode !== 0) throw new Error(`fzf exited with code ${exitCode}`)
				return output.trim() || null
			},
			catch: (cause) =>
				new Error("Failed to select task input with fzf", { cause }),
		}),
}

export const task = (
	options: TaskOptions,
	interaction: TaskInteraction = defaultInteraction,
) =>
	Effect.gen(function* () {
		const tasks = yield* TaskService
		const epics = yield* EpicService
		const repositories = yield* RepositoryService
		const { log } = createLoggers(options)
		const cwd = options.cwd ?? process.cwd()

		switch (options.subcommand) {
			case "new": {
				if (options.inputAllowed === false) {
					return yield* Effect.fail(
						new Error(
							"task new requires interactive input; use 'agency task create <id> --repo <alias>' for automation",
						),
					)
				}
				const id =
					options.args[0] ?? (yield* interaction.text("Task ID: ")).trim()
				if (!id) {
					return yield* Effect.fail(new Error("Task ID is required"))
				}

				let ticketUrl = options.ticketUrl?.trim() || null
				let description = options.description?.trim() || undefined
				let epic = options.epic
				let multiPhase = options.multiPhase ?? false
				let repo = options.repo

				if (options.ticketUrl === undefined) {
					ticketUrl =
						(yield* interaction.text("Ticket URL (optional): ")).trim() || null
				}
				if (options.description === undefined) {
					description =
						(yield* interaction.text("Description (optional): ")).trim() ||
						undefined
				}
				if (options.epic === undefined) {
					const epicRecords = yield* epics.list(cwd)
					if (epicRecords.length > 0) {
						const none = "(none)"
						const selected = yield* interaction.select("Parent epic", [
							none,
							...epicRecords.map((record) => record.id),
						])
						if (selected === null) {
							return yield* Effect.fail(new Error("Task creation cancelled"))
						}
						epic = selected === none ? undefined : selected
					}
				}
				if (options.multiPhase === undefined) {
					const selected = yield* interaction.select("Task type", [
						"single-phase",
						"multi-phase",
					])
					if (selected === null) {
						return yield* Effect.fail(new Error("Task creation cancelled"))
					}
					multiPhase = selected === "multi-phase"
				}

				if (!multiPhase && !repo) {
					const records = yield* repositories.list(cwd)
					if (records.length === 0) {
						return yield* Effect.fail(
							new Error(
								"No repositories found; add or link a repository first",
							),
						)
					}
					const selected = yield* interaction.select(
						"Writable repository",
						records.map((record) => record.alias),
					)
					if (!selected) {
						return yield* Effect.fail(new Error("Task creation cancelled"))
					}
					repo = selected
				}

				const record = yield* tasks.create(
					{
						id,
						ticketUrl,
						description,
						epic,
						multiPhase,
						repo,
						repos: parseRepositoryReferences(options.references),
						branch: multiPhase ? undefined : (options.branch ?? `task/${id}`),
						base: multiPhase ? undefined : (options.base ?? "main"),
					},
					cwd,
				)
				const { content: _, ...output } = record
				log(
					options.json
						? JSON.stringify(output, null, 2)
						: `Created task '${record.id}'`,
				)
				return
			}
			case "create": {
				const id = options.args[0]
				if (!id) {
					return yield* Effect.fail(new Error("Task ID is required"))
				}
				const multiPhase = options.multiPhase ?? false
				if (!multiPhase && !options.repo) {
					return yield* Effect.fail(
						new Error("Writable repository is required for task create"),
					)
				}
				const record = yield* tasks.create(
					{
						id,
						ticketUrl: options.ticketUrl?.trim() || null,
						description: options.description?.trim() || undefined,
						epic: options.epic,
						multiPhase,
						repo: options.repo,
						repos: parseRepositoryReferences(options.references),
						branch: multiPhase ? undefined : (options.branch ?? `task/${id}`),
						base: multiPhase ? undefined : (options.base ?? "main"),
					},
					cwd,
				)
				const { content: _, ...output } = record
				log(
					options.json
						? JSON.stringify(output, null, 2)
						: `Created task '${record.id}'`,
				)
				return
			}
			case "list": {
				const records = yield* tasks.list(cwd)
				if (options.json) {
					log(
						JSON.stringify(
							records.map(({ content: _, ...record }) => record),
							null,
							2,
						),
					)
				} else {
					for (const record of records) log(record.id)
				}
				return
			}
			case "show": {
				const id = options.args[0]
				if (!id) return yield* Effect.fail(new Error("Task ID is required"))
				const record = yield* tasks.show(id, cwd)
				const { content: _, ...output } = record
				log(
					options.json
						? JSON.stringify(output, null, 2)
						: record.content.trimEnd(),
				)
				return
			}
			case "status": {
				const [id, status] = options.args
				if (!id || !status) {
					return yield* Effect.fail(
						new Error("Usage: agency task status <id> <status>"),
					)
				}
				const record = yield* tasks.setStatus(id, status, cwd)
				const { content: _, ...output } = record
				log(
					options.json
						? JSON.stringify(output, null, 2)
						: `Marked task '${id}' as ${record.data.status}`,
				)
				return
			}
			default:
				return yield* Effect.fail(
					new Error(
						"Subcommand is required. Available: new, create, list, show, status",
					),
				)
		}
	})

export const help = `
Usage: agency task <subcommand>

Subcommands:
  new [id]              Create a task with guided input
  create <id>           Create a task without prompting
  list                  List tasks
  show <id>             Show a task
  status <id> <status>  Set open, working, delegated, done, or dropped

Create options:
  --ticket-url <url>    External ticket URL (optional)
  --description <text>  Short description of the task
  --epic <id>           Parent epic
  --repo <alias>        Writable repository
  --reference <alias>:<ref>
                        Read-only repository reference; repeatable
  --branch <name>       Working branch (default: task/<id>)
  --base <name>         Base branch (default: main)
  --multi-phase         Create a task container for phases

Task creation is noninteractive. Single-phase tasks require --repo; use
--multi-phase instead for a task container. Guided input is available only
through task new, which fails when --no-input is set or no TTY is available.

Options:
  --json                Output results as JSON
  --no-input            Never open interactive task creation
`
