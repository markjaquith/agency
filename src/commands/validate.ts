import { Data, Effect } from "effect"
import type { BaseCommandOptions } from "../utils/command"
import { WorkbaseService } from "../services/WorkbaseService"
import { createLoggers } from "../utils/effect"
import {
	pickWorkbase,
	resolveWorkbase,
	type PickWorkbase,
} from "../workbase/workbase-choice"

interface ValidateOptions extends BaseCommandOptions {
	readonly path?: string
	readonly json?: boolean
}

class ValidationFailedError extends Data.TaggedError("ValidationFailedError")<{
	readonly message: string
	readonly root: string
	readonly issues: readonly {
		readonly path: string
		readonly message: string
	}[]
}> {}

export const validate = (
	options: ValidateOptions = {},
	pick: PickWorkbase = pickWorkbase,
) =>
	Effect.gen(function* () {
		const workbase = yield* WorkbaseService
		const { log } = createLoggers(options)
		const startPath = options.path ?? options.cwd ?? process.cwd()
		const root = options.path
			? yield* workbase.discover(startPath)
			: yield* resolveWorkbase(
					startPath,
					log,
					pick,
					options.inputAllowed ?? true,
				)
		if (!root) return
		const report = yield* workbase.validate(root)

		if (options.json) {
			log(JSON.stringify(report, null, 2))
		}

		if (!report.valid) {
			const details = report.issues
				.map((issue) => `- ${issue.path}: ${issue.message}`)
				.join("\n")
			return yield* new ValidationFailedError({
				message: `Workbase validation failed with ${report.issues.length} issue${report.issues.length === 1 ? "" : "s"}:\n${details}`,
				root: report.root,
				issues: report.issues,
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
Usage: agency validate [path] [options]

Validate a workbase's configuration, frontmatter, references, and dependency
graphs. The current or selected registered workbase is used when path is omitted.

Options:
  --json              Output the validation report as JSON
  --no-input          Never open an interactive workbase selector

When interactive input is unavailable, pass a path or run this command from a
workbase. Registered-workbase selection otherwise fails.
`
