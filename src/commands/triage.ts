import { Effect } from "effect"
import { basename } from "node:path"
import type { TriageReport, TriageReportItem } from "../triage-schema"
import { TriageService } from "../services/TriageService"
import type { BaseCommandOptions } from "../utils/command"
import { createLoggers } from "../utils/effect"
import { formatTable } from "../utils/table"

interface TriageCommandOptions extends BaseCommandOptions {
	readonly workbase?: string
	readonly archived?: boolean
	readonly item?: string
	readonly configDirectory?: string
	readonly env?: NodeJS.ProcessEnv
}

const itemLabel = (item: TriageReportItem) => {
	const unit = item.subject.item
	if (unit) return unit.phaseId ? `${unit.taskId}/${unit.phaseId}` : unit.taskId
	const pane = item.subject.runtime[0]
	return pane ? `pane ${pane.paneId}` : item.key
}

const workbaseLabel = (item: TriageReportItem) => {
	const workbase = item.subject.workbase
	return workbase
		? (workbase.name ?? workbase.id ?? basename(workbase.root))
		: "-"
}

const formatReport = (report: TriageReport) => {
	const lines: string[] = []
	if (report.items.length === 0) lines.push("Nothing to triage.")
	else
		lines.push(
			formatTable(
				["WORKBASE", "ITEM", "STATUS", "SUMMARY", "NEXT ACTION", "SOURCE"],
				report.items.map((item) => [
					workbaseLabel(item),
					itemLabel(item),
					item.assessment?.status ?? "-",
					item.assessment?.question
						? `${item.assessment.summary} Asks: ${item.assessment.question}`
						: (item.assessment?.summary ?? item.error ?? "-"),
					item.assessment?.actions[0]?.title ?? "-",
					item.source,
				]),
			),
		)
	for (const failure of report.failures) {
		const scope = failure.workbase
			? (failure.workbase.name ?? failure.workbase.root)
			: "unowned panes"
		lines.push(
			"",
			`Triage failed for ${scope} after ${failure.attempts} attempt(s): ${failure.message}`,
			...failure.errors.map((error) => `  - ${error}`),
		)
	}
	return lines.join("\n")
}

export const triage = (options: TriageCommandOptions = {}) =>
	Effect.gen(function* () {
		const { log } = createLoggers(options)
		const report = yield* (yield* TriageService).triage({
			workbase: options.workbase,
			archived: options.archived,
			item: options.item,
			cwd: options.cwd,
			configDirectory: options.configDirectory,
			env: options.env,
		})
		log(options.json ? JSON.stringify(report, null, 2) : formatReport(report))
	})

export const help = `
Usage: agency triage [options]

Run an LLM triage pass over supervised work: every item with attention
signals, a live agent pane, or an active claim. A headless, read-only
OpenCode agent assesses each item and ranks recommended actions in the
agency-action-v1 schema. Only items whose state changed since their cached
assessment are re-evaluated; results are kept in the local state directory.

Options:
  --json                 Output one versioned machine result
  --item <ref>           Re-evaluate only this item: a task, task/phase,
                         execution unit, pane ID, or item key
  --archived             Also inspect every archived execution unit
  --workbase <selector>  Triage only one registered workbase

Prompts: "triage": {"prompt", "promptFile"} in the global agency.json and in
each workbase's agency.json add instructions to the locked response contract;
the global "triage.model" selects the OpenCode model. Recommended actions are
never executed by this command.
`
