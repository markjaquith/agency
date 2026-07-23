import { Effect } from "effect"
import type { BaseCommandOptions } from "../utils/command"
import { PhaseService } from "../services/PhaseService"
import { createLoggers } from "../utils/effect"
import { formatTable } from "../utils/table"
import { getWorkViews } from "../work-view"
import { parseRepositoryReferences } from "../workbase/repository-reference"
import { GraphMutationService } from "../services/GraphMutationService"
import { work as startWork, type StartWork } from "./work"

interface PhaseOptions extends BaseCommandOptions {
	readonly subcommand?: string
	readonly args: readonly string[]
	readonly description?: string
	readonly clearDescription?: boolean
	readonly repo?: string
	readonly references?: readonly string[]
	readonly branch?: string
	readonly base?: string
	readonly clearReferences?: boolean
	readonly prUrl?: string
	readonly clearPr?: boolean
	readonly ifRevision?: string
	readonly dependsOn?: readonly string[]
	readonly firstPhase?: string
	readonly json?: boolean
	readonly statuses?: readonly string[]
	readonly repositories?: readonly string[]
	readonly ready?: boolean
	readonly blocked?: boolean
	readonly pr?: boolean
	readonly work?: boolean
	readonly auto?: boolean
}

export const phase = (options: PhaseOptions, work: StartWork = startWork) =>
	Effect.gen(function* () {
		const phases = yield* PhaseService
		const mutations = yield* GraphMutationService
		const { log } = createLoggers(options)
		const cwd = options.cwd ?? process.cwd()
		const [taskId, phaseId] = options.args

		switch (options.subcommand) {
			case "new":
			case "create": {
				if (
					!taskId ||
					!phaseId ||
					!options.repo ||
					!options.branch ||
					!options.base
				) {
					return yield* Effect.fail(
						new Error(
							"Usage: agency phase create <task-id> <phase-id> --repo <alias> --branch <name> --base <name>",
						),
					)
				}
				const record = yield* phases.create(
					{
						taskId,
						id: phaseId,
						description: options.description,
						repo: options.repo,
						repos: parseRepositoryReferences(options.references),
						branch: options.branch,
						base: options.base,
						dependsOn: options.dependsOn,
						firstPhase: options.firstPhase,
					},
					cwd,
				)
				const { content: _, ...output } = record
				log(
					options.json
						? JSON.stringify(output, null, 2)
						: `Created phase '${record.id}' on task '${record.taskId}'`,
				)
				if (options.subcommand === "new" && options.work) {
					yield* work({
						taskId: record.taskId,
						phaseId: record.id,
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
				if (!taskId) return yield* Effect.fail(new Error("Task ID is required"))
				const records = yield* phases.list(taskId, cwd)
				const { phaseRows } = yield* getWorkViews({
					cwd,
					statuses: options.statuses,
					repositories: options.repositories,
					ready: options.ready,
					blocked: options.blocked,
					pr: options.pr,
				})
				const rows = phaseRows.filter((row) => row.parent === taskId)
				const ordered = rows.flatMap((row) => {
					const record = records.find((item) => item.id === row.id)
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
								"PHASE",
								"PARENT",
								"STATUS",
								"READINESS",
								"REPOSITORIES",
								"BRANCH",
								"PR",
								"WORKTREE",
							],
							rows.map((row) => [
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
				if (!taskId || !phaseId) {
					return yield* Effect.fail(
						new Error("Task ID and phase ID are required"),
					)
				}
				const record = yield* phases.show(taskId, phaseId, cwd)
				const { content: _, ...output } = record
				log(
					options.json
						? JSON.stringify(output, null, 2)
						: record.content.trimEnd(),
				)
				return
			}
			case "status": {
				const status = options.args[2]
				if (!taskId || !phaseId || !status) {
					return yield* Effect.fail(
						new Error(
							"Usage: agency phase status <task-id> <phase-id> <status>",
						),
					)
				}
				const record = yield* phases.setStatus(taskId, phaseId, status, cwd)
				const { content: _, ...output } = record
				log(
					options.json
						? JSON.stringify(output, null, 2)
						: `Marked phase '${phaseId}' as ${record.data.status}`,
				)
				return
			}
			case "update": {
				if (!taskId || !phaseId) {
					return yield* Effect.fail(
						new Error("Task ID and phase ID are required"),
					)
				}
				const output = yield* mutations.updatePhase(
					taskId,
					phaseId,
					{
						description: options.clearDescription ? null : options.description,
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
					options.ifRevision,
				)
				log(
					options.json
						? JSON.stringify(output, null, 2)
						: `Updated phase '${phaseId}'`,
				)
				return
			}
			case "rename": {
				const newId = options.args[2]
				if (!taskId || !phaseId || !newId) {
					return yield* Effect.fail(
						new Error("Task ID, phase ID, and new ID are required"),
					)
				}
				const output = yield* mutations.renamePhase(
					taskId,
					phaseId,
					newId,
					cwd,
					options.ifRevision,
				)
				log(
					options.json
						? JSON.stringify(output, null, 2)
						: `Renamed phase '${phaseId}' to '${newId}'`,
				)
				return
			}
			case "dependency": {
				const [operation, dependencyTaskId, dependencyPhaseId, dependencyId] =
					options.args
				if (
					(operation !== "add" && operation !== "remove") ||
					!dependencyTaskId ||
					!dependencyPhaseId ||
					!dependencyId
				) {
					return yield* Effect.fail(
						new Error(
							"Usage: agency phase dependency <add|remove> <task-id> <phase-id> <dependency-id>",
						),
					)
				}
				const output = yield* mutations.mutatePhaseDependency(
					operation,
					dependencyTaskId,
					dependencyPhaseId,
					dependencyId,
					cwd,
					options.ifRevision,
				)
				log(
					options.json
						? JSON.stringify(output, null, 2)
						: `${operation === "add" ? "Added" : "Removed"} dependency '${dependencyId}' ${operation === "add" ? "to" : "from"} phase '${dependencyPhaseId}'`,
				)
				return
			}
			default:
				return yield* Effect.fail(
					new Error(
						"Subcommand is required. Available: new, create, list, show, status, update, rename, dependency",
					),
				)
		}
	})

export const help = `
Usage: agency phase <subcommand> <task-id> [phase-id]

Subcommands:
  new <task> <phase>    Create a phase, optionally starting work
  create <task> <phase> Create a phase
  list <task>           List task phases
  show <task> <phase>   Show a phase
  status <task> <phase> <status>
                        Set open, working, or dropped
  update <task> <phase> Update phase metadata
  rename <task> <phase> <new-id>
                        Rename a phase and update dependencies
  dependency <operation> <task> <phase> <dependency>
                        Add or remove a phase dependency

Mutation option:
  --if-revision <hash>  Require the target's current revision

Create options:
  --description <text>  Short description of the phase
  --repo <alias>        Writable repository
  --reference <alias>:<ref>
                        Read-only repository reference; repeatable
  --branch <name>       Working branch
  --base <name>         Base branch
  --depends-on <id>     Phase dependency; repeatable
  --first-phase <id>    Existing execution phase ID when converting a task
  --work                Start work on the new phase after creating it
  --auto                Pass --auto to work; requires --work

Update options:
  --description <text> / --clear-description
  --repo <alias>        Replace the writable repository
  --reference <alias>:<ref> / --clear-references
  --branch <name>       Replace the working branch
  --base <name>         Replace the base branch
  --pr-url <url> / --clear-pr

Options:
  --json                Output results as JSON
  --status <status>     Filter list by status; repeatable
  --repository <alias>  Filter list by repository; repeatable
  --ready               Include only ready phases
  --blocked             Include only blocked phases
  --pr / --no-pr        Filter by recorded PR presence
`
