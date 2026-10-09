import { Effect } from "effect"
import { autoArchiveMessage } from "../services/auto-archive"
import type { BaseCommandOptions } from "../utils/command"
import { PhaseService } from "../services/PhaseService"
import { createLoggers } from "../utils/effect"
import { formatTable } from "../utils/table"
import { getWorkViews } from "../work-view"
import { parseRepositoryReferences } from "../workbase/repository-reference"
import { GraphMutationService } from "../services/GraphMutationService"
import { work as startWork, type StartWork } from "./work"
import { TaskService } from "../services/TaskService"
import { resolveBranchName } from "../workbase/branch-name-command"
import {
	resolveDependencySelector,
	resolvePhaseSelector,
	resolveTaskSelector,
	splitSelectorArgs,
} from "../workbase/item-selector"

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
	readonly noPullRequest?: boolean
	readonly summary?: string
	readonly evidenceUrl?: string
}

export const phase = (options: PhaseOptions, work: StartWork = startWork) =>
	Effect.gen(function* () {
		const phases = yield* PhaseService
		const tasks = yield* TaskService
		const mutations = yield* GraphMutationService
		const { log } = createLoggers(options)
		const cwd = options.cwd ?? process.cwd()
		const selectPhase = (trailing: number) => {
			const { selectors, operands } = splitSelectorArgs(options.args, trailing)
			return resolvePhaseSelector(selectors[0], selectors[1], cwd).pipe(
				Effect.map((target) => ({ ...target, operands })),
			)
		}

		switch (options.subcommand) {
			case "new":
			case "create": {
				const {
					selectors: [selector],
					operands: [phaseId],
				} = splitSelectorArgs(options.args, 1)
				if (!phaseId || !options.repo || !options.base) {
					return yield* Effect.fail(
						new Error(
							"Usage: agency phase create [task] <phase-id> --repo <alias> --base <name> [--branch <name>]",
						),
					)
				}
				const { root, taskId } = yield* resolveTaskSelector(selector, cwd)
				const parent = yield* tasks.show(taskId, root)
				const branch =
					options.branch ??
					(yield* resolveBranchName({
						id: phaseId,
						taskId,
						phaseId,
						ticketUrl: parent.data.ticketUrl,
						repo: options.repo,
						base: options.base,
						defaultBranch: `task/${taskId}-${phaseId}`,
						startPath: root,
					}))
				const record = yield* phases.create(
					{
						taskId,
						id: phaseId,
						description: options.description,
						repo: options.repo,
						repos: parseRepositoryReferences(options.references),
						branch,
						base: options.base,
						dependsOn: options.dependsOn,
						firstPhase: options.firstPhase,
					},
					root,
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
						cwd: root,
						inputAllowed: options.inputAllowed,
						silent: options.silent,
						verbose: options.verbose,
					})
				}
				return
			}
			case "list": {
				const { root, taskId } = yield* resolveTaskSelector(
					options.args[0],
					cwd,
				)
				const records = yield* phases.list(taskId, root)
				const { phaseRows } = yield* getWorkViews({
					cwd: root,
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
				const { root, taskId, phaseId } = yield* selectPhase(0)
				const record = yield* phases.show(taskId, phaseId, root)
				const { content: _, ...output } = record
				log(
					options.json
						? JSON.stringify(output, null, 2)
						: record.content.trimEnd(),
				)
				return
			}
			case "status": {
				const {
					root,
					taskId,
					phaseId,
					operands: [status],
				} = yield* selectPhase(1)
				if (!status) {
					return yield* Effect.fail(
						new Error(
							"Usage: agency phase status [<phase> | <task> <phase-id>] <status>",
						),
					)
				}
				const record = yield* phases.setStatus(
					taskId,
					phaseId,
					status,
					root,
					options.noPullRequest
						? {
								summary: options.summary ?? "",
								...(options.evidenceUrl
									? { evidenceUrl: options.evidenceUrl }
									: {}),
							}
						: undefined,
				)
				const { content: _, ...output } = record
				log(
					options.json
						? JSON.stringify(output, null, 2)
						: `Marked phase '${phaseId}' as ${record.data.status}`,
				)
				const notice = autoArchiveMessage(record.autoArchive)
				if (!options.json && notice) log(notice)
				return
			}
			case "update": {
				const { root, taskId, phaseId } = yield* selectPhase(0)
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
					root,
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
				if (options.args.length === 0) {
					return yield* Effect.fail(new Error("New phase ID is required"))
				}
				const {
					root,
					taskId,
					phaseId,
					operands: [newId],
				} = yield* selectPhase(1)
				const output = yield* mutations.renamePhase(
					taskId,
					phaseId,
					newId!,
					root,
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
				const [operation, ...rest] = options.args
				const {
					selectors: [selector, selectedPhaseId],
					operands: [dependency],
				} = splitSelectorArgs(rest, 1)
				if ((operation !== "add" && operation !== "remove") || !dependency) {
					return yield* Effect.fail(
						new Error(
							"Usage: agency phase dependency <add|remove> [<phase> | <task> <phase-id>] <dependency>",
						),
					)
				}
				const {
					root,
					taskId: dependencyTaskId,
					phaseId: dependencyPhaseId,
				} = yield* resolvePhaseSelector(selector, selectedPhaseId, cwd)
				const dependencyId = yield* resolveDependencySelector(
					"phase",
					dependency,
					cwd,
				)
				const output = yield* mutations.mutatePhaseDependency(
					operation,
					dependencyTaskId,
					dependencyPhaseId,
					dependencyId,
					root,
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
Usage: agency phase <subcommand> [selector] [arguments]

Subcommands:
  new [task] <phase-id> Create a phase, optionally starting work
  create [task] <phase-id>
                        Create a phase
  list [task]           List task phases
  show [phase]          Show a phase
  status [phase] <status>
                        Set open, working, dropped, or explicit non-PR done
  update [phase]        Update phase metadata
  rename [phase] <new-id>
                        Rename a phase and update dependencies
  dependency <operation> [phase] <dependency>
                        Add or remove a phase dependency

A [task] selector is a task ID or a path to a task document or directory. A
[phase] selector is <task> <phase-id>, a path to a phase document or directory,
or a phase ID of the task containing the current directory. When omitted, the
task or phase containing the current directory is used.

Mutation option:
  --if-revision <hash>  Require the target's current revision

Non-PR completion options (status done only):
  --no-pull-request     Complete without a pull request
  --summary <text>      Required durable outcome summary
  --evidence-url <url>  Optional supporting record

Create options:
  --description <text>  Short description of the phase
  --repo <alias>        Writable repository
  --reference <alias>:<ref>
                        Read-only repository reference; repeatable
  --branch <name>       Working branch (default: configured resolver or task/<task>-<phase>)
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
