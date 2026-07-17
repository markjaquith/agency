import { Effect } from "effect"
import { DoctorService } from "../services/DoctorService"
import type { BaseCommandOptions } from "../utils/command"
import { createLoggers } from "../utils/effect"

interface DoctorOptions extends BaseCommandOptions {
	readonly json?: boolean
}

export const doctor = (options: DoctorOptions = {}) =>
	Effect.gen(function* () {
		const service = yield* DoctorService
		const { log } = createLoggers(options)
		const report = yield* service.inspect(options.cwd ?? process.cwd())

		if (options.json) {
			log(JSON.stringify(report, null, 2))
			return
		}

		for (const check of report.checks) {
			const marker =
				check.status === "pass"
					? "PASS"
					: check.level === "error"
						? "ERROR"
						: check.level === "warning"
							? "WARN"
							: "OPTIONAL"
			log(`${marker}\t${check.id}\t${check.message}`)
			if (check.remediation) log(`  Remediation: ${check.remediation}`)
		}
		log("")
		log(
			`${report.healthy ? "Healthy" : "Unhealthy"}: ${report.summary.errors} error(s), ${report.summary.warnings} warning(s), ${report.summary.optional} unavailable optional capability(s)`,
		)
	})

export const help = `
Usage: agency doctor [options]

Diagnose tools, integrations, repositories, refs, worktrees, permissions, and
managed-file drift without changing the workbase.

Options:
  --json  Output the health report as JSON
`
