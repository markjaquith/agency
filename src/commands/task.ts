import { Effect } from "effect"
import { createInterface } from "node:readline/promises"
import type { BaseCommandOptions } from "../utils/command"
import { TaskService } from "../services/TaskService"
import { EpicService } from "../services/EpicService"
import { RepositoryService } from "../services/RepositoryService"
import { createLoggers } from "../utils/effect"
import { parseRepositoryReferences } from "../workbase/repository-reference"
import { WorkbaseService } from "../services/WorkbaseService"
import { choose } from "../utils/chooser"
import { formatTable } from "../utils/table"
import { getWorkViews } from "../work-view"
import { GraphMutationService } from "../services/GraphMutationService"

interface TaskOptions extends BaseCommandOptions {
	readonly subcommand?: string
	readonly args: readonly string[]
	readonly ticketUrl?: string
	readonly description?: string
	readonly clearDescription?: boolean
	readonly clearTicket?: boolean
	readonly epic?: string
	readonly repo?: string
	readonly references?: readonly string[]
	readonly branch?: string
	readonly base?: string
	readonly clearReferences?: boolean
	readonly prUrl?: string
	readonly clearPr?: boolean
	readonly noEpic?: boolean
	readonly multiPhase?: boolean
	readonly json?: boolean
	readonly statuses?: readonly string[]
	readonly repositories?: readonly string[]
	readonly ready?: boolean
	readonly blocked?: boolean
	readonly pr?: boolean
}

export interface TaskInteraction {
	readonly text: (prompt: string) => Effect.Effect<string, Error>
	readonly select: (
		prompt: string,
		choices: readonly string[],
	) => Effect.Effect<string | null, Error>
}

const defaultInteraction = (
	chooserCommand?: readonly string[],
): TaskInteraction => ({
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
		choose(
			prompt,
			choices.map((choice, index) => ({
				key: String(index),
				label: choice,
				value: choice,
			})),
			chooserCommand,
		),
})

export const task = (options: TaskOptions, interaction?: TaskInteraction) =>
	Effect.gen(function* () {
		const tasks = yield* TaskService
		const epics = yield* EpicService
		const repositories = yield* RepositoryService
		const workbase = yield* WorkbaseService
		const mutations = yield* GraphMutationService
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
				const activeInteraction =
					interaction ??
					defaultInteraction(
						(yield* workbase.loadConfig(cwd)).config.chooserCommand,
					)
				const id =
					options.args[0] ?? (yield* activeInteraction.text("Task ID: ")).trim()
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
						(yield* activeInteraction.text("Ticket URL (optional): ")).trim() ||
						null
				}
				if (options.description === undefined) {
					description =
						(yield* activeInteraction.text(
							"Description (optional): ",
						)).trim() || undefined
				}
				if (options.epic === undefined) {
					const epicRecords = yield* epics.list(cwd)
					if (epicRecords.length > 0) {
						const none = "(none)"
						const selected = yield* activeInteraction.select("Parent epic", [
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
					const selected = yield* activeInteraction.select("Task type", [
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
					const selected = yield* activeInteraction.select(
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
				const { taskRows } = yield* getWorkViews({
					cwd,
					statuses: options.statuses,
					repositories: options.repositories,
					ready: options.ready,
					blocked: options.blocked,
					pr: options.pr,
				})
				const ordered = taskRows.flatMap((row) => {
					const record = records.find((item) => item.id === row.key)
					return record ? [record] : []
				})
				if (options.json) {
					log(
						JSON.stringify(
							ordered.map(({ content: _, ...record }) => record),
							null,
							2,
						),
					)
				} else {
					log(
						formatTable(
							[
								"TASK",
								"PARENT",
								"STATUS",
								"READINESS",
								"REPOSITORIES",
								"BRANCH",
								"PR",
								"WORKTREE",
							],
							taskRows.map((row) => [
								row.id,
								row.parent,
								row.status,
								row.readiness,
								row.repositories,
								row.branch,
								row.pr,
								row.worktree,
							]),
						),
					)
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
			case "update": {
				const id = options.args[0]
				if (!id) return yield* Effect.fail(new Error("Task ID is required"))
				const output = yield* mutations.updateTask(
					id,
					{
						description: options.clearDescription ? null : options.description,
						ticketUrl: options.clearTicket ? null : options.ticketUrl,
						repo: options.repo,
						repos: options.clearReferences
							? null
							: options.references === undefined
								? undefined
								: parseRepositoryReferences(options.references),
						branch: options.branch,
						base: options.base,
						pr: options.clearPr ? null : options.prUrl,
					},
					cwd,
				)
				log(
					options.json
						? JSON.stringify(output, null, 2)
						: `Updated task '${id}'`,
				)
				return
			}
			case "rename": {
				const [id, newId] = options.args
				if (!id || !newId) {
					return yield* Effect.fail(
						new Error("Task ID and new ID are required"),
					)
				}
				const output = yield* mutations.renameTask(id, newId, cwd)
				log(
					options.json
						? JSON.stringify(output, null, 2)
						: `Renamed task '${id}' to '${newId}'`,
				)
				return
			}
			case "move": {
				const id = options.args[0]
				if (!id) return yield* Effect.fail(new Error("Task ID is required"))
				const output = yield* mutations.moveTask(
					id,
					options.noEpic ? null : (options.epic ?? null),
					cwd,
				)
				log(
					options.json
						? JSON.stringify(output, null, 2)
						: options.noEpic
							? `Removed task '${id}' from its epic`
							: `Moved task '${id}' to epic '${options.epic}'`,
				)
				return
			}
			case "dependency": {
				const [operation, id, dependencyId] = options.args
				if (
					(operation !== "add" && operation !== "remove") ||
					!id ||
					!dependencyId
				) {
					return yield* Effect.fail(
						new Error(
							"Usage: agency task dependency <add|remove> <task-id> <dependency-id>",
						),
					)
				}
				const output = yield* mutations.mutateTaskDependency(
					operation,
					id,
					dependencyId,
					cwd,
				)
				log(
					options.json
						? JSON.stringify(output, null, 2)
						: `${operation === "add" ? "Added" : "Removed"} dependency '${dependencyId}' ${operation === "add" ? "to" : "from"} task '${id}'`,
				)
				return
			}
			default:
				return yield* Effect.fail(
					new Error(
						"Subcommand is required. Available: new, create, list, show, status, update, rename, move, dependency",
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
  status <id> <status>  Set open, done, or dropped
  update <id>           Update task metadata
  rename <id> <new-id>  Rename a task and update graph references
  move <id>             Move a task with --epic or --no-epic
  dependency <operation> <task> <dependency>
                        Add or remove a task dependency

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

Update options:
  --ticket-url <url> / --clear-ticket
  --description <text> / --clear-description
  --repo <alias>        Replace the writable repository
  --reference <alias>:<ref> / --clear-references
  --branch <name>       Replace the working branch
  --base <name>         Replace the base branch
  --pr-url <url> / --clear-pr

Task creation is noninteractive. Single-phase tasks require --repo; use
--multi-phase instead for a task container. Guided input is available only
through task new, which fails when --no-input is set or no TTY is available.

Options:
  --json                Output results as JSON
  --no-input            Never open interactive task creation
  --status <status>     Filter list by status; repeatable
  --repository <alias>  Filter list by repository; repeatable
  --ready               Include only ready tasks
  --blocked             Include only blocked tasks
  --pr / --no-pr        Filter by recorded PR presence
`
