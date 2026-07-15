import { Data, Effect } from "effect"
import type { BaseCommandOptions } from "../utils/command"
import { WorkbaseService } from "../services/WorkbaseService"
import { createLoggers } from "../utils/effect"

interface ValidateOptions extends BaseCommandOptions {
	readonly json?: boolean
}

class ValidationFailedError extends Data.TaggedError("ValidationFailedError")<{
	readonly message: string
}> {}

export const validate = (options: ValidateOptions = {}) =>
	Effect.gen(function* () {
		const workbase = yield* WorkbaseService
		const { log } = createLoggers(options)
		const report = yield* workbase.validate(options.cwd ?? process.cwd())

		if (options.json) {
			log(JSON.stringify(report, null, 2))
		}

		if (!report.valid) {
			const details = report.issues
				.map((issue) => `- ${issue.path}: ${issue.message}`)
				.join("\n")
			return yield* new ValidationFailedError({
				message: `Workbase validation failed with ${report.issues.length} issue${report.issues.length === 1 ? "" : "s"}:\n${details}`,
			})
		}

		if (!options.json) {
			log(
				`Valid workbase: ${report.epicCount} epic${report.epicCount === 1 ? "" : "s"}, ` +
					`${report.taskCount} task${report.taskCount === 1 ? "" : "s"}, ` +
					`${report.phaseCount} phase${report.phaseCount === 1 ? "" : "s"}`,
			)
		}
	})

export const help = `
Usage: agency validate [options]

Validate the current workbase configuration, frontmatter, references, and
dependency graphs.

Options:
  --json              Output the validation report as JSON
`
