import { Effect } from "effect"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import type { BaseCommandOptions } from "../utils/command"
import { WorktreeService } from "../services/WorktreeService"
import { FileSystemService } from "../services/FileSystemService"
import { WorkbaseService } from "../services/WorkbaseService"
import { EpicService } from "../services/EpicService"
import { TaskService } from "../services/TaskService"
import { PhaseService } from "../services/PhaseService"
import { ClaimService } from "../services/ClaimService"
import { createLoggers } from "../utils/effect"
import { execvp } from "../utils/exec"
import { createProgress, type Progress } from "../utils/progress"
import {
	buildWorkTargetChoices,
	pickWorkTarget,
	type PickWorkTarget,
	type WorkTarget,
} from "../workbase/work-target"
import {
	pickWorkbase,
	resolveWorkbase,
	type PickWorkbase,
} from "../workbase/workbase-choice"

interface WorkOptions extends BaseCommandOptions {
	readonly directory?: string
	readonly taskId?: string
	readonly phaseId?: string
	readonly epicId?: string
	readonly opencode?: boolean
	readonly claude?: boolean
}

type LaunchAgent = (cli: string, args: readonly string[], cwd: string) => void

const formatCommand = (args: readonly string[]) =>
	args
		.map((argument) =>
			/^[A-Za-z0-9_./:=+@%-]+$/.test(argument)
				? argument
				: `'${argument.replaceAll("'", `'\\''`)}'`,
		)
		.join(" ")

const launchAgent: LaunchAgent = (cli, args, cwd) => {
	process.chdir(cwd)
	execvp(cli, [...args])
}

export const work = (
	options: WorkOptions = {},
	launch: LaunchAgent = launchAgent,
	pick: PickWorkTarget = pickWorkTarget,
	progress: Progress = createProgress(options),
	pickBase: PickWorkbase = pickWorkbase,
) =>
	Effect.gen(function* () {
		if (options.opencode && options.claude) {
			return yield* Effect.fail(
				new Error("Cannot use both --opencode and --claude"),
			)
		}
		const previousSessionId = process.env.AGENCY_SESSION_ID
		const previousClaimRevision = process.env.AGENCY_CLAIM_REVISION
		if (
			options.epicId &&
			(options.directory || options.taskId || options.phaseId)
		) {
			return yield* Effect.fail(
				new Error("Cannot combine --epic with a directory, task, or phase ID"),
			)
		}

		const worktrees = yield* WorktreeService
		const fs = yield* FileSystemService
		const workbase = yield* WorkbaseService
		const epics = yield* EpicService
		const tasks = yield* TaskService
		const phases = yield* PhaseService
		const claims = yield* ClaimService
		const { log, verboseLog } = createLoggers(options)
		const cwd = options.cwd ?? process.cwd()
		const directoryPath = options.directory
			? resolve(cwd, options.directory)
			: undefined
		const isDirectory = directoryPath
			? yield* fs.isDirectory(directoryPath)
			: false
		const startPath = isDirectory && directoryPath ? directoryPath : cwd
		const inputAllowed = options.inputAllowed ?? true
		const root = yield* resolveWorkbase(startPath, pickBase, inputAllowed)
		if (!root) return

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
		} else if (options.directory && !isDirectory) {
			const task = yield* tasks.show(options.directory, root)
			target = {
				kind: "task",
				taskId: task.id,
				path: task.path,
				multiPhase: "phases" in task.data,
			}
		} else if (directoryPath) {
			const path = relative(root, startPath)
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
			if (!inputAllowed) {
				return yield* Effect.fail(
					new Error(
						"Work target selection requires interactive input; provide a directory, task ID, or --epic <id>",
					),
				)
			}
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
			const { config } = yield* workbase.loadConfig(root)
			target = yield* pick(choices, config.chooserCommand)
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
			progress.start("Preparing workspace...")
			const workspace = yield* worktrees
				.materialize(taskId, phaseId, root, options)
				.pipe(
					Effect.tap(() =>
						Effect.sync(() => progress.succeed("Workspace ready")),
					),
					Effect.tapError(() =>
						Effect.sync(() => progress.fail("Workspace preparation failed")),
					),
				)
			prompt = workspace.phasePath
				? `Start the task. Read ${workspace.taskPath} and ${workspace.phasePath}.`
				: `Start the task. Read ${workspace.taskPath}.`
			launchPath = workspace.writablePath
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
		if (
			target.kind === "phase" ||
			(target.kind === "task" && !target.multiPhase)
		) {
			const phaseId = target.kind === "phase" ? target.phaseId : undefined
			const current = yield* claims.inspect(target.taskId, phaseId, root)
			const sessionId =
				process.env.AGENCY_SESSION_ID ?? `${process.pid}-${Date.now()}`
			const acquired = yield* claims.claim(
				{
					taskId: target.taskId,
					...(phaseId ? { phaseId } : {}),
					claimant: process.env.AGENCY_CLAIMANT ?? process.env.USER ?? "agency",
					runner: process.env.AGENCY_RUNNER ?? cli,
					sessionId,
					revision: current.revision,
				},
				root,
			)
			process.env.AGENCY_SESSION_ID = sessionId
			process.env.AGENCY_CLAIM_REVISION = acquired.revision
		}

		const args =
			cli === "opencode" ? ["--continue", "--prompt", prompt] : [prompt]
		verboseLog(
			`Launching command: ${formatCommand([cli, ...args])} (cwd: ${launchPath})`,
		)
		try {
			launch(cli, [cli, ...args], launchPath)
		} finally {
			if (previousSessionId === undefined) delete process.env.AGENCY_SESSION_ID
			else process.env.AGENCY_SESSION_ID = previousSessionId
			if (previousClaimRevision === undefined)
				delete process.env.AGENCY_CLAIM_REVISION
			else process.env.AGENCY_CLAIM_REVISION = previousClaimRevision
		}
	})

export const workPrepare = (options: WorkOptions = {}) =>
	Effect.gen(function* () {
		const fs = yield* FileSystemService
		const workbase = yield* WorkbaseService
		const tasks = yield* TaskService
		const phases = yield* PhaseService
		const worktrees = yield* WorktreeService
		const { log } = createLoggers(options)
		const cwd = options.cwd ?? process.cwd()
		const targetPath = options.directory ? resolve(cwd, options.directory) : cwd
		const isDirectory = yield* fs.isDirectory(targetPath)
		const root = yield* workbase.discover(isDirectory ? targetPath : cwd)

		let taskId: string | undefined
		let phaseId: string | undefined
		if (options.directory && !isDirectory) {
			const task = yield* tasks.show(options.directory, root)
			taskId = task.id
		} else {
			const path = relative(root, targetPath)
			const parts =
				!path || isAbsolute(path) || path.startsWith(`..${sep}`)
					? []
					: path.split(sep)
			if (parts[0] === "tasks" && parts[1]) {
				const task = yield* tasks.show(parts[1], root)
				taskId = task.id
				if (parts[2] === "phases" && parts[3]) {
					const phase = yield* phases.show(task.id, parts[3], root)
					phaseId = phase.id
				}
			}
		}

		if (!taskId) {
			return yield* Effect.fail(
				new Error(
					"Work preparation requires a task ID or a path inside an execution unit",
				),
			)
		}

		const workspace = yield* worktrees.materialize(taskId, phaseId, root, {
			...options,
			dryRun: options.dryRun,
		})
		if (options.json) {
			log(JSON.stringify(workspace, null, 2))
		} else {
			log(
				`${workspace.dryRun ? "Workspace plan" : "Workspace ready"}: ${workspace.writablePath}`,
			)
		}
	})

export const help = `
Usage: agency work [<directory-or-task-id> | --epic <epic-id>]
       agency work prepare [target] [--dry-run] [--json]

Launch an agent for an epic, task, or phase. With no directory, select one
interactively. A positional argument resolves as a directory first, then as a task
ID. Use '.' for the current directory. Outside a workbase, select a registered
workbase first.

The prepare subcommand resolves and materializes an execution workspace without
launching an agent or changing lifecycle status. --dry-run reports planned Git
changes without fetching, creating branches, or creating worktrees.

Options:
  --epic <id>         Work on an epic
  --opencode           Require OpenCode
  --claude             Require Claude Code
  --no-input          Never open an interactive selector

Without interactive input, provide a directory, task ID, or --epic and run the
command from a workbase. Workbase and target selection otherwise fail.
`
