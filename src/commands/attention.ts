import { Effect } from "effect"
import { basename } from "node:path"
import type { AttentionReport, AttentionSignal } from "../attention-schema"
import { SupervisionService } from "../services/SupervisionService"
import type { BaseCommandOptions } from "../utils/command"
import { createLoggers } from "../utils/effect"
import { formatTable } from "../utils/table"

interface AttentionCommandOptions extends BaseCommandOptions {
	readonly workbase?: string
	readonly archived?: boolean
	readonly configDirectory?: string
}

const workbaseLabel = (workbase: {
	readonly id: string | null
	readonly name: string | null
	readonly root: string
}) => workbase.name ?? workbase.id ?? basename(workbase.root)

const subjectLabel = (signal: AttentionSignal) => {
	const item = signal.subject.item
	if (item) return item.phaseId ? `${item.taskId}/${item.phaseId}` : item.taskId
	const pane = signal.subject.runtime[0]
	return pane ? `pane ${pane.paneId}` : "-"
}

const formatReport = (report: AttentionReport) => {
	const lines: string[] = []
	if (!report.runtime.available) {
		lines.push(
			report.runtime.error
				? `Runtime unavailable: ${report.runtime.error}`
				: "No runtime detected; runtime signals are skipped.",
		)
	}
	for (const workbase of report.workbases) {
		if (workbase.error)
			lines.push(
				`Workbase ${workbaseLabel(workbase)} unavailable: ${workbase.error}`,
			)
	}
	if (report.signals.length === 0) {
		lines.push("Nothing needs attention.")
		return lines.join("\n")
	}
	if (lines.length) lines.push("")
	lines.push(
		formatTable(
			["WORKBASE", "SIGNAL", "SUBJECT", "SUMMARY", "ACTIONS"],
			report.signals.map((signal) => [
				signal.subject.workbase ? workbaseLabel(signal.subject.workbase) : "-",
				signal.kind,
				subjectLabel(signal),
				signal.title,
				String(signal.actions.length),
			]),
		),
	)
	return lines.join("\n")
}

export const attention = (options: AttentionCommandOptions = {}) =>
	Effect.gen(function* () {
		const { log } = createLoggers(options)
		const report = yield* (yield* SupervisionService).attention({
			workbase: options.workbase,
			archived: options.archived,
			cwd: options.cwd,
			configDirectory: options.configDirectory,
		})
		log(options.json ? JSON.stringify(report, null, 2) : formatReport(report))
	})

export const help = `
Usage: agency attention [options]

Report deterministic "needs attention" signals across every registered
workbase, the current workbase, and workbases hosting live agent panes, each
with suggested actions in the agency-action-v1 schema.

Options:
  --json                 Output one versioned machine result
  --archived             Also inspect every archived execution unit; bound
                         archived units are always inspected
  --workbase <selector>  Inspect only one registered workbase

Signals join Agency state with live pull request, ticket, and runtime (Herdr)
state. Suggested actions are never executed by this command.
`
