import { Effect } from "effect"

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
	  }
	| {
			readonly kind: "phase"
			readonly taskId: string
			readonly phaseId: string
			readonly path: string
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
		| { readonly description?: string }
}

interface PhaseRecord {
	readonly taskId: string
	readonly id: string
	readonly path: string
	readonly data: { readonly description?: string }
}

export interface WorkTargetChoice {
	readonly label: string
	readonly target: WorkTarget
}

const label = (
	indent: string,
	kind: WorkTarget["kind"],
	id: string,
	description?: string,
) =>
	`${indent}${
		{
			epic: "\x1b[35m\x1b[0m",
			task: "\x1b[36m󰗡\x1b[0m",
			phase: "\x1b[33m󰔚\x1b[0m",
		}[kind]
	} ${id}${description === undefined ? "" : `\x1b[2m - ${description}\x1b[0m`}`

const taskChoices = (
	task: TaskRecord,
	phaseRecords: readonly PhaseRecord[],
	indent: string,
): readonly WorkTargetChoice[] => {
	const multiPhase = "phases" in task.data
	const choices: WorkTargetChoice[] = [
		{
			label: label(indent, "task", task.id, task.data.description),
			target: {
				kind: "task",
				taskId: task.id,
				path: task.path,
				multiPhase,
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
			label: label(`${indent}  `, "phase", record.id, record.data.description),
			target: {
				kind: "phase",
				taskId: task.id,
				phaseId: record.id,
				path: record.path,
			},
		})
	}
	for (const record of phaseRecords) {
		if (renderedPhases.has(record.id)) continue
		choices.push({
			label: label(`${indent}  `, "phase", record.id, record.data.description),
			target: {
				kind: "phase",
				taskId: task.id,
				phaseId: record.id,
				path: record.path,
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
) => Effect.Effect<WorkTarget | null, Error>

const parseWorkTargetSelection = (
	output: string,
	choices: readonly WorkTargetChoice[],
) => {
	const index = Number.parseInt(output.split("\t", 1)[0] ?? "", 10)
	return choices[index]?.target ?? null
}

export const pickWorkTarget: PickWorkTarget = (choices) =>
	Effect.tryPromise({
		try: async () => {
			const input = choices
				.map((choice, index) => `${index}\t${choice.label}`)
				.join("\n")
			const process = Bun.spawn(
				[
					"fzf",
					"--ansi",
					"--delimiter=\t",
					"--with-nth=2..",
					"--prompt=Work on> ",
				],
				{ stdin: new Blob([input]), stdout: "pipe", stderr: "inherit" },
			)
			const [exitCode, output] = await Promise.all([
				process.exited,
				new Response(process.stdout).text(),
			])
			if (exitCode === 1 || exitCode === 130) return null
			if (exitCode !== 0) throw new Error(`fzf exited with code ${exitCode}`)
			return parseWorkTargetSelection(output, choices)
		},
		catch: (cause) =>
			new Error("Failed to select a work target with fzf", { cause }),
	})
