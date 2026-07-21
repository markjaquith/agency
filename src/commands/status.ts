import { Effect } from "effect"
import type { BaseCommandOptions } from "../utils/command"
import { WorkbaseService } from "../services/WorkbaseService"
import { RepositoryService } from "../services/RepositoryService"
import { createLoggers } from "../utils/effect"
import { formatTable } from "../utils/table"
import { getWorkViews } from "../work-view"

interface StatusOptions extends BaseCommandOptions {
	readonly json?: boolean
	readonly statuses?: readonly string[]
	readonly repositories?: readonly string[]
	readonly ready?: boolean
	readonly blocked?: boolean
	readonly pr?: boolean
}

export const status = (options: StatusOptions = {}) =>
	Effect.gen(function* () {
		const workbase = yield* WorkbaseService
		const repositories = yield* RepositoryService
		const { log } = createLoggers(options)
		const cwd = options.cwd ?? process.cwd()
		const report = yield* workbase.validate(cwd)
		const repos = yield* repositories.list(report.root)
		const executionRows = report.valid
			? (yield* getWorkViews({
					cwd,
					validation: report,
					statuses: options.statuses,
					repositories: options.repositories,
					ready: options.ready,
					blocked: options.blocked,
					pr: options.pr,
				})).executionRows
			: []
		const data = { ...report, repositories: repos, work: executionRows }

		if (options.json) {
			log(JSON.stringify(data, null, 2))
			return
		}

		log(`Workbase: ${report.root}`)
		log(`Repositories: ${repos.length}`)
		for (const repo of repos) log(`  ${repo.alias}: ${repo.states.join(", ")}`)
		log(`Epics: ${report.epicCount}`)
		log(`Tasks: ${report.taskCount}`)
		log(`Phases: ${report.phaseCount}`)
		log(
			`Validation: ${report.valid ? "valid" : `${report.issues.length} issues`}`,
		)
		log("")
		log(
			formatTable(
				[
					"KIND",
					"WORK",
					"PARENT",
					"STATUS",
					"READINESS",
					"REPOSITORIES",
					"BRANCH",
					"PR",
					"WORKTREE",
				],
				executionRows.map((row) => [
					row.kind,
					row.kind === "phase" ? row.key : row.id,
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
	})

export const help = `
Usage: agency status [options]

Show workbase repository, entity, and validation status.

Options:
  --json                Output status as JSON
  --status <status>     Filter by status; repeatable
  --repository <alias>  Filter by repository; repeatable
  --ready               Include only ready work
  --blocked             Include only blocked work
  --pr / --no-pr        Filter by recorded PR presence
`
