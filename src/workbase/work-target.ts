import { Effect } from "effect"
import type { WorkStatus } from "./schemas"
import { choose, type ChoiceSegment } from "../utils/chooser"
import { macchiato } from "../utils/theme"

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
	readonly depth: number
	readonly segments: readonly ChoiceSegment[]
	readonly target: WorkTarget
}

const statuses: Record<
	WorkStatus,
	{ readonly icon: string; readonly color: string }
> = {
	open: { icon: "󰄱", color: macchiato.overlay1 },
	working: { icon: "󰔟", color: macchiato.blue },
	delegated: { icon: "󰁕", color: macchiato.mauve },
	done: { icon: "󰄬", color: macchiato.green },
	dropped: { icon: "󰅖", color: macchiato.red },
}

const kinds: Record<
	WorkTarget["kind"],
	{ readonly icon: string; readonly color: string }
> = {
	epic: { icon: "", color: macchiato.mauve },
	task: { icon: "󰗡", color: macchiato.sapphire },
	phase: { icon: "󰔚", color: macchiato.yellow },
}

const hexToAnsi = (color: string) => {
	const value = color.slice(1)
	return [0, 2, 4]
		.map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16))
		.join(";")
}

const colorize = (item: { readonly icon: string; readonly color: string }) =>
	`\x1b[38;2;${hexToAnsi(item.color)}m${item.icon}\x1b[0m`

const label = (
	kind: WorkTarget["kind"],
	id: string,
	description?: string,
	status?: WorkStatus,
) =>
	`${status === undefined ? "" : `${colorize(statuses[status])} `}${colorize(kinds[kind])} ${id}${description === undefined ? "" : `\x1b[2m - ${description}\x1b[0m`}`

const segments = (
	kind: WorkTarget["kind"],
	id: string,
	description?: string,
	status?: WorkStatus,
): readonly ChoiceSegment[] => [
	...(status === undefined
		? []
		: [
				{ text: statuses[status].icon, color: statuses[status].color },
				{ text: " " },
			]),
	{ text: kinds[kind].icon, color: kinds[kind].color },
	{ text: ` ${id}` },
	...(description === undefined
		? []
		: [{ text: ` - ${description}`, color: macchiato.overlay0 }]),
]

const plainLabel = (
	kind: WorkTarget["kind"],
	id: string,
	description?: string,
	status?: WorkStatus,
) =>
	`${status === undefined ? "" : `[${status}] `}${kind} ${id}${description === undefined ? "" : ` - ${description}`}`

const taskChoices = (
	task: TaskRecord,
	phaseRecords: readonly PhaseRecord[],
	depth: number,
): readonly WorkTargetChoice[] => {
	const multiPhase = "phases" in task.data
	const choices: WorkTargetChoice[] = [
		{
			label: label(
				"task",
				task.id,
				task.data.description,
				multiPhase ? undefined : (task.data.status ?? "open"),
			),
			plainLabel: plainLabel(
				"task",
				task.id,
				task.data.description,
				multiPhase ? undefined : (task.data.status ?? "open"),
			),
			depth,
			segments: segments(
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
				"phase",
				record.id,
				record.data.description,
				record.data.status ?? "open",
			),
			plainLabel: plainLabel(
				"phase",
				record.id,
				record.data.description,
				record.data.status ?? "open",
			),
			depth: depth + 1,
			segments: segments(
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
				"phase",
				record.id,
				record.data.description,
				record.data.status ?? "open",
			),
			plainLabel: plainLabel(
				"phase",
				record.id,
				record.data.description,
				record.data.status ?? "open",
			),
			depth: depth + 1,
			segments: segments(
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
			label: label("epic", epic.id, epic.data.description),
			plainLabel: plainLabel("epic", epic.id, epic.data.description),
			depth: 0,
			segments: segments("epic", epic.id, epic.data.description),
			target: { kind: "epic", epicId: epic.id, path: epic.path },
		})
		for (const child of epic.data.tasks) {
			const task = tasks.get(child.id)
			if (!task || nestedTasks.has(task.id)) continue
			nestedTasks.add(task.id)
			choices.push(...taskChoices(task, phases.get(task.id) ?? [], 1))
		}
	}

	for (const task of taskRecords) {
		if (nestedTasks.has(task.id)) continue
		choices.push(...taskChoices(task, phases.get(task.id) ?? [], 0))
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
			depth: choice.depth,
			segments: choice.segments,
			value: choice.target,
		})),
		command,
	)
