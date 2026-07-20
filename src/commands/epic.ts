import { Effect } from "effect"
import type { BaseCommandOptions } from "../utils/command"
import { EpicService } from "../services/EpicService"
import { createLoggers } from "../utils/effect"
import { formatTable } from "../utils/table"
import { getWorkViews } from "../work-view"
import { parseRepositoryReferences } from "../workbase/repository-reference"
import { GraphMutationService } from "../services/GraphMutationService"
import { work as startWork, type StartWork } from "./work"

interface EpicOptions extends BaseCommandOptions {
	readonly subcommand?: string
	readonly args: readonly string[]
	readonly ticketUrl?: string
	readonly description?: string
	readonly clearDescription?: boolean
	readonly ifRevision?: string
	readonly repos?: readonly string[]
	readonly json?: boolean
	readonly statuses?: readonly string[]
	readonly repositories?: readonly string[]
	readonly ready?: boolean
	readonly blocked?: boolean
	readonly pr?: boolean
	readonly work?: boolean
	readonly auto?: boolean
}

export const epic = (options: EpicOptions, work: StartWork = startWork) =>
	Effect.gen(function* () {
		const epics = yield* EpicService
		const mutations = yield* GraphMutationService
		const { log } = createLoggers(options)
		const cwd = options.cwd ?? process.cwd()

		switch (options.subcommand) {
			case "new":
			case "create": {
				const id = options.args[0]
				if (!id || !options.ticketUrl || !options.repos?.length) {
					return yield* Effect.fail(
						new Error(
							"Usage: agency epic create <id> --ticket-url <url> --repo <alias>:<ref>",
						),
					)
				}
				const record = yield* epics.create(
					id,
					options.ticketUrl,
					parseRepositoryReferences(options.repos),
					cwd,
					options.description,
				)
				const { content: _, ...output } = record
				log(
					options.json
						? JSON.stringify(output, null, 2)
						: `Created epic '${record.id}'`,
				)
				if (options.subcommand === "new" && options.work) {
					yield* work({
						epicId: record.id,
						auto: options.auto,
						cwd,
						inputAllowed: options.inputAllowed,
						silent: options.silent,
						verbose: options.verbose,
					})
				}
				return
			}

			case "list": {
				const records = yield* epics.list(cwd)
				const { epicRows } = yield* getWorkViews({
					cwd,
					statuses: options.statuses,
					repositories: options.repositories,
					ready: options.ready,
					blocked: options.blocked,
					pr: options.pr,
				})
				const ordered = epicRows.flatMap((row) => {
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
							["EPIC", "STATUS", "READINESS", "REPOSITORIES", "PR", "WORKTREE"],
							epicRows.map((row) => [
								row.id,
								row.status,
								row.readiness,
								row.repositories,
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
				if (!id) return yield* Effect.fail(new Error("Epic ID is required"))
				const record = yield* epics.show(id, cwd)
				const { content: _, ...output } = record
				log(
					options.json
						? JSON.stringify(output, null, 2)
						: record.content.trimEnd(),
				)
				return
			}

			case "update": {
				const id = options.args[0]
				if (!id) return yield* Effect.fail(new Error("Epic ID is required"))
				const output = yield* mutations.updateEpic(
					id,
					{
						description: options.clearDescription ? null : options.description,
						ticketUrl: options.ticketUrl,
						repos:
							options.repos === undefined
								? undefined
								: parseRepositoryReferences(options.repos),
					},
					cwd,
					options.ifRevision,
				)
				log(
					options.json
						? JSON.stringify(output, null, 2)
						: `Updated epic '${id}'`,
				)
				return
			}

			case "rename": {
				const [id, newId] = options.args
				if (!id || !newId) {
					return yield* Effect.fail(
						new Error("Epic ID and new ID are required"),
					)
				}
				const output = yield* mutations.renameEpic(
					id,
					newId,
					cwd,
					options.ifRevision,
				)
				log(
					options.json
						? JSON.stringify(output, null, 2)
						: `Renamed epic '${id}' to '${newId}'`,
				)
				return
			}

			default:
				return yield* Effect.fail(
					new Error(
						"Subcommand is required. Available subcommands: new, create, list, show, update, rename",
					),
				)
		}
	})

export const help = `
Usage: agency epic <subcommand>

Subcommands:
  new <id>              Create an epic, optionally starting work
  create <id>           Create an epic
  list                  List epics
  show <id>             Show an epic
  update <id>           Update epic metadata
  rename <id> <new-id>  Rename an epic and update task references

Create options:
  --ticket-url <url>    External ticket URL
  --description <text>  Short description of the epic
  --repo <alias>:<ref>  Read-only repository reference; repeatable
  --work                Start work on the new epic after creating it
  --auto                Pass --auto to work; requires --work

Update options:
  --ticket-url <url>    Replace the external ticket URL
  --description <text>  Replace the description
  --clear-description   Remove the description
  --repo <alias>:<ref>  Replace repository references; repeatable

Mutation options:
  --if-revision <hash>  Require the target's current revision

Options:
  --json                Output results as JSON
  --status <status>     Filter list by status; repeatable
  --repository <alias>  Filter list by repository; repeatable
  --ready               Include only ready epics
  --blocked             Include only blocked epics
  --pr / --no-pr        Filter by recorded PR presence
`
