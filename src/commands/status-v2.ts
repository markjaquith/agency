import { Effect } from "effect"
import type { BaseCommandOptions } from "../utils/command"
import { WorkbaseService } from "../services/WorkbaseService"
import { RepositoryService } from "../services/RepositoryService"
import { createLoggers } from "../utils/effect"

interface StatusOptions extends BaseCommandOptions {
	readonly json?: boolean
}

export const status = (options: StatusOptions = {}) =>
	Effect.gen(function* () {
		const workbase = yield* WorkbaseService
		const repositories = yield* RepositoryService
		const { log } = createLoggers(options)
		const cwd = options.cwd ?? process.cwd()
		const report = yield* workbase.validate(cwd)
		const repos = yield* repositories.list(report.root)
		const data = { ...report, repositories: repos }

		if (options.json) {
			log(JSON.stringify(data, null, 2))
			return
		}

		log(`Workbase: ${report.root}`)
		log(`Repositories: ${repos.length}`)
		log(`Epics: ${report.epicCount}`)
		log(`Tasks: ${report.taskCount}`)
		log(`Phases: ${report.phaseCount}`)
		log(
			`Validation: ${report.valid ? "valid" : `${report.issues.length} issues`}`,
		)
	})

export const help = `
Usage: agency status [options]

Show workbase repository, entity, and validation status.

Options:
  --json              Output status as JSON
`
