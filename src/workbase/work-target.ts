import { Effect } from "effect"
import type { WorkStatus } from "./schemas"
import { choose } from "../utils/chooser"

export type WorkTarget =
	| {
			readonly kind: "epic"
			readonly epicId: string
			readonly path: string
	  }
	| {
			readonly kind: "task"
			readonly taskId: string
			readonly path: string
			readonly multiPhase: boolean
			readonly status?: WorkStatus
	  }
	| {
			readonly kind: "phase"
			readonly taskId: string
			readonly phaseId: string
			readonly path: string
			readonly status?: WorkStatus
	  }

interface EpicRecord {
	readonly id: string
	readonly path: string
	readonly data: {
		readonly description?: string
		readonly tasks: readonly { readonly id: string }[]
	}
}

interface TaskRecord {
	readonly id: string
	readonly path: string
	readonly data:
		| {
				readonly description?: string
				readonly phases: readonly { readonly id: string }[]
		  }
		| { readonly description?: string; readonly status?: WorkStatus }
}

interface PhaseRecord {
	readonly taskId: string
	readonly id: string
	readonly path: string
	readonly data: {
		readonly description?: string
		readonly status?: WorkStatus
	}
}

export interface WorkTargetChoice {
	readonly label: string
	readonly plainLabel: string
	readonly target: WorkTarget
}

const statusIcons: Record<WorkStatus, string> = {
	open: "\x1b[2m○\x1b[0m",
	working: "\x1b[34m◐\x1b[0m",
	delegated: "\x1b[35m↗\x1b[0m",
	done: "\x1b[32m✓\x1b[0m",
	dropped: "\x1b[31m⊘\x1b[0m",
}

const label = (
	indent: string,
	kind: WorkTarget["kind"],
	id: string,
	description?: string,
	status?: WorkStatus,
) =>
	`${indent}${status === undefined ? "" : `${statusIcons[status]} `}${
		{
			epic: "\x1b[35m\x1b[0m",
			task: "\x1b[36m󰗡\x1b[0m",
			phase: "\x1b[33m󰔚\x1b[0m",
		}[kind]
	} ${id}${description === undefined ? "" : `\x1b[2m - ${description}\x1b[0m`}`

const plainLabel = (
	indent: string,
	kind: WorkTarget["kind"],
	id: string,
	description?: string,
	status?: WorkStatus,
) =>
	`${indent}${status === undefined ? "" : `[${status}] `}${kind} ${id}${description === undefined ? "" : ` - ${description}`}`

const taskChoices = (
	task: TaskRecord,
	phaseRecords: readonly PhaseRecord[],
	indent: string,
): readonly WorkTargetChoice[] => {
	const multiPhase = "phases" in task.data
	const choices: WorkTargetChoice[] = [
		{
			label: label(
				indent,
				"task",
				task.id,
				task.data.description,
				multiPhase ? undefined : (task.data.status ?? "open"),
			),
			plainLabel: plainLabel(
				indent,
				"task",
				task.id,
				task.data.description,
				multiPhase ? undefined : (task.data.status ?? "open"),
			),
			target: {
				kind: "task",
				taskId: task.id,
				path: task.path,
				multiPhase,
				status: multiPhase ? undefined : (task.data.status ?? "open"),
			},
		},
	]
	if (!multiPhase) return choices

	const phases = new Map(phaseRecords.map((phase) => [phase.id, phase]))
	const renderedPhases = new Set<string>()
	for (const phase of task.data.phases) {
		const record = phases.get(phase.id)
		if (!record) continue
		renderedPhases.add(record.id)
		choices.push({
			label: label(
				`${indent}  `,
				"phase",
				record.id,
				record.data.description,
				record.data.status ?? "open",
			),
			plainLabel: plainLabel(
				`${indent}  `,
				"phase",
				record.id,
				record.data.description,
				record.data.status ?? "open",
			),
			target: {
				kind: "phase",
				taskId: task.id,
				phaseId: record.id,
				path: record.path,
				status: record.data.status ?? "open",
			},
		})
	}
	for (const record of phaseRecords) {
		if (renderedPhases.has(record.id)) continue
		choices.push({
			label: label(
				`${indent}  `,
				"phase",
				record.id,
				record.data.description,
				record.data.status ?? "open",
			),
			plainLabel: plainLabel(
				`${indent}  `,
				"phase",
				record.id,
				record.data.description,
				record.data.status ?? "open",
			),
			target: {
				kind: "phase",
				taskId: task.id,
				phaseId: record.id,
				path: record.path,
				status: record.data.status ?? "open",
			},
		})
	}
	return choices
}

export const buildWorkTargetChoices = (
	epicRecords: readonly EpicRecord[],
	taskRecords: readonly TaskRecord[],
	phaseRecords: readonly PhaseRecord[],
): readonly WorkTargetChoice[] => {
	const choices: WorkTargetChoice[] = []
	const tasks = new Map(taskRecords.map((task) => [task.id, task]))
	const phases = new Map<string, PhaseRecord[]>()
	for (const phase of phaseRecords) {
		const records = phases.get(phase.taskId) ?? []
		records.push(phase)
		phases.set(phase.taskId, records)
	}
	const nestedTasks = new Set<string>()

	for (const epic of epicRecords) {
		choices.push({
			label: label("", "epic", epic.id, epic.data.description),
			plainLabel: plainLabel("", "epic", epic.id, epic.data.description),
			target: { kind: "epic", epicId: epic.id, path: epic.path },
		})
		for (const child of epic.data.tasks) {
			const task = tasks.get(child.id)
			if (!task || nestedTasks.has(task.id)) continue
			nestedTasks.add(task.id)
			choices.push(...taskChoices(task, phases.get(task.id) ?? [], "  "))
		}
	}

	for (const task of taskRecords) {
		if (nestedTasks.has(task.id)) continue
		choices.push(...taskChoices(task, phases.get(task.id) ?? [], ""))
	}

	return choices
}

export type PickWorkTarget = (
	choices: readonly WorkTargetChoice[],
	command?: readonly string[],
) => Effect.Effect<WorkTarget | null, Error>

export const pickWorkTarget: PickWorkTarget = (choices, command) =>
	choose(
		"Work on",
		choices.map((choice, index) => ({
			key: String(index),
			label: choice.label,
			plainLabel: choice.plainLabel,
			value: choice.target,
		})),
		command,
	)
