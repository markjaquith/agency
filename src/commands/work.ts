import { Effect } from "effect"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import type { BaseCommandOptions } from "../utils/command"
import { WorktreeService } from "../services/WorktreeService"
import { FileSystemService } from "../services/FileSystemService"
import { WorkbaseService } from "../services/WorkbaseService"
import { EpicService } from "../services/EpicService"
import { TaskService } from "../services/TaskService"
import { PhaseService } from "../services/PhaseService"
import { createLoggers } from "../utils/effect"
import { execvp } from "../utils/exec"
import {
	buildWorkTargetChoices,
	pickWorkTarget,
	type PickWorkTarget,
	type WorkTarget,
} from "../workbase/work-target"

interface WorkOptions extends BaseCommandOptions {
	readonly taskId?: string
	readonly phaseId?: string
	readonly epicId?: string
	readonly opencode?: boolean
	readonly claude?: boolean
}

type LaunchAgent = (cli: string, args: readonly string[], cwd: string) => void

const launchAgent: LaunchAgent = (cli, args, cwd) => {
	process.chdir(cwd)
	execvp(cli, [...args])
}

export const work = (
	options: WorkOptions = {},
	launch: LaunchAgent = launchAgent,
	pick: PickWorkTarget = pickWorkTarget,
) =>
	Effect.gen(function* () {
		if (options.opencode && options.claude) {
			return yield* Effect.fail(
				new Error("Cannot use both --opencode and --claude"),
			)
		}
		if (options.epicId && (options.taskId || options.phaseId)) {
			return yield* Effect.fail(
				new Error("Cannot combine --epic with a task or phase ID"),
			)
		}

		const worktrees = yield* WorktreeService
		const fs = yield* FileSystemService
		const workbase = yield* WorkbaseService
		const epics = yield* EpicService
		const tasks = yield* TaskService
		const phases = yield* PhaseService
		const { log, verboseLog } = createLoggers(options)
		const cwd = options.cwd ?? process.cwd()
		const root = yield* workbase.discover(cwd)

		let target: WorkTarget | null = null
		if (options.epicId) {
			const epic = yield* epics.show(options.epicId, root)
			target = { kind: "epic", epicId: epic.id, path: epic.path }
		} else if (options.taskId) {
			const task = yield* tasks.show(options.taskId, root)
			if (options.phaseId) {
				const phase = yield* phases.show(task.id, options.phaseId, root)
				target = {
					kind: "phase",
					taskId: task.id,
					phaseId: phase.id,
					path: phase.path,
				}
			} else {
				target = {
					kind: "task",
					taskId: task.id,
					path: task.path,
					multiPhase: "phases" in task.data,
				}
			}
		} else {
			const path = relative(root, resolve(cwd))
			const parts =
				!path || isAbsolute(path) || path.startsWith(`..${sep}`)
					? []
					: path.split(sep)
			if (parts[0] === "epics" && parts[1]) {
				const epic = yield* epics.show(parts[1], root)
				target = { kind: "epic", epicId: epic.id, path: epic.path }
			} else if (parts[0] === "tasks" && parts[1]) {
				const task = yield* tasks.show(parts[1], root)
				if (parts[2] === "phases" && parts[3]) {
					const phase = yield* phases.show(task.id, parts[3], root)
					target = {
						kind: "phase",
						taskId: task.id,
						phaseId: phase.id,
						path: phase.path,
					}
				} else {
					target = {
						kind: "task",
						taskId: task.id,
						path: task.path,
						multiPhase: "phases" in task.data,
					}
				}
			}
		}

		if (!target) {
			const epicRecords = yield* epics.list(root)
			const taskRecords = yield* tasks.list(root)
			const phaseRecords = []
			for (const task of taskRecords) {
				if ("phases" in task.data) {
					phaseRecords.push(...(yield* phases.list(task.id, root)))
				}
			}
			const choices = buildWorkTargetChoices(
				epicRecords,
				taskRecords,
				phaseRecords,
			)
			if (choices.length === 0) {
				return yield* Effect.fail(
					new Error("No epics, tasks, or phases found in this workbase"),
				)
			}
			const fzf = yield* fs.runCommand(["which", "fzf"], {
				captureOutput: true,
			})
			if (fzf.exitCode !== 0) {
				for (const choice of choices) log(choice.label)
				return yield* Effect.fail(
					new Error(
						"fzf is required to select a work target; install fzf or provide a target explicitly",
					),
				)
			}
			target = yield* pick(choices)
			if (!target) return
		}

		let prompt: string
		let launchPath: string
		if (target.kind === "epic") {
			prompt = `Work on the epic. Read ${target.path}.`
			launchPath = dirname(target.path)
		} else if (target.kind === "task" && target.multiPhase) {
			prompt = `Work on the task. Read ${target.path}.`
			launchPath = dirname(target.path)
		} else {
			const taskId = target.taskId
			const phaseId = target.kind === "phase" ? target.phaseId : undefined
			const workspace = yield* worktrees.materialize(
				taskId,
				phaseId,
				root,
				options,
			)
			prompt = workspace.phasePath
				? `Start the task. Read ${workspace.taskPath} and ${workspace.phasePath}.`
				: `Start the task. Read ${workspace.taskPath}.`
			launchPath = dirname(target.path)
		}

		const requested = options.claude ? "claude" : "opencode"
		let cli = requested
		let available = yield* fs.runCommand(["which", cli], {
			captureOutput: true,
		})
		if (available.exitCode !== 0 && !options.opencode && !options.claude) {
			cli = "claude"
			available = yield* fs.runCommand(["which", cli], { captureOutput: true })
		}
		if (available.exitCode !== 0) {
			return yield* Effect.fail(new Error(`${cli} CLI tool not found`))
		}
		if (target.kind === "phase") {
			yield* phases.setStatus(target.taskId, target.phaseId, "working", root)
		} else if (target.kind === "task" && !target.multiPhase) {
			yield* tasks.setStatus(target.taskId, "working", root)
		}

		verboseLog(`Launching ${cli} in ${launchPath}`)
		const args = cli === "opencode" ? ["--prompt", prompt] : [prompt]
		launch(cli, [cli, ...args], launchPath)
	})

export const help = `
Usage: agency work [<task-id> [phase-id] | --epic <epic-id>]

Launch an agent for the current epic, task, or phase. Outside an entity
directory, select one with fzf.

Options:
  --epic <id>         Work on an epic
  --opencode           Require OpenCode
  --claude             Require Claude Code
`
