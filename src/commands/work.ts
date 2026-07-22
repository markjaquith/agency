import { Effect } from "effect"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import type { BaseCommandOptions } from "../utils/command"
import { WorktreeService } from "../services/WorktreeService"
import { FileSystemService } from "../services/FileSystemService"
import { WorkbaseService } from "../services/WorkbaseService"
import { EpicService } from "../services/EpicService"
import { TaskService } from "../services/TaskService"
import { PhaseService } from "../services/PhaseService"
import { ReadinessService } from "../services/ReadinessService"
import { IntegrationService } from "../services/IntegrationService"
import { createLoggers } from "../utils/effect"
import { execvp } from "../utils/exec"
import { createProgress, type Progress } from "../utils/progress"
import { isTerminalStatus } from "../readiness"
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
import {
	printableEnvironment,
	resolveRunnerCommand,
	runnerEnvironment,
} from "../workbase/runner-command"

export interface WorkOptions extends BaseCommandOptions {
	readonly directory?: string
	readonly taskId?: string
	readonly phaseId?: string
	readonly epicId?: string
	readonly opencode?: boolean
	readonly claude?: boolean
	readonly runner?: string
	readonly printCommand?: boolean
	readonly auto?: boolean
	readonly force?: boolean
}

export type StartWork = (options: WorkOptions) => ReturnType<typeof work>

type LaunchAgent = (
	cli: string,
	args: readonly string[],
	cwd: string,
	environment: Readonly<Record<string, string>>,
) => void

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

const targetNodeId = (target: WorkTarget) => {
	if (target.kind === "epic") return `epic:${target.epicId}`
	if (target.kind === "phase") {
		return `execution-unit:phase/${target.taskId}/${target.phaseId}`
	}
	return target.multiPhase
		? `task:${target.taskId}`
		: `execution-unit:task/${target.taskId}`
}

export const work = (
	options: WorkOptions = {},
	launch: LaunchAgent = launchAgent,
	pick: PickWorkTarget = pickWorkTarget,
	progress: Progress = createProgress(options),
	pickBase: PickWorkbase = pickWorkbase,
) =>
	Effect.gen(function* () {
		if (
			(options.opencode && options.claude) ||
			(options.runner && (options.opencode || options.claude))
		) {
			return yield* Effect.fail(
				new Error("Cannot combine --runner, --opencode, and --claude"),
			)
		}
		const previousEnvironment = { ...process.env }
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
		const readiness = yield* ReadinessService
		const integrations = yield* IntegrationService
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
		yield* integrations.sync(root)
		const { config } = yield* workbase.loadConfig(root)

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
					status: phase.data.status,
				}
			} else {
				target = {
					kind: "task",
					taskId: task.id,
					path: task.path,
					multiPhase: "phases" in task.data,
					status: "phases" in task.data ? undefined : task.data.status,
				}
			}
		} else if (options.directory && !isDirectory) {
			const task = yield* tasks.show(options.directory, root)
			target = {
				kind: "task",
				taskId: task.id,
				path: task.path,
				multiPhase: "phases" in task.data,
				status: "phases" in task.data ? undefined : task.data.status,
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
						status: phase.data.status,
					}
				} else {
					target = {
						kind: "task",
						taskId: task.id,
						path: task.path,
						multiPhase: "phases" in task.data,
						status: "phases" in task.data ? undefined : task.data.status,
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
			const allChoices = buildWorkTargetChoices(
				epicRecords,
				taskRecords,
				phaseRecords,
			)
			const workTargetIds = options.force
				? null
				: yield* readiness.getWorkTargetIds(root)
			const choices = options.force
				? allChoices
				: allChoices.filter((choice) =>
						workTargetIds!.has(targetNodeId(choice.target)),
					)
			if (choices.length === 0) {
				return yield* Effect.fail(
					new Error("No ready work targets found in this workbase"),
				)
			}
			target = yield* pick(choices, config.chooserCommand)
			if (!target) return
		}
		yield* readiness.guardWorkTarget(targetNodeId(target), root, options.force)

		const continuing =
			target.kind !== "epic" &&
			!(target.kind === "task" && target.multiPhase) &&
			(process.env.AGENCY_SESSION_ID !== undefined ||
				(target.status !== undefined && target.status !== "open"))
		let prompt: string
		let launchPath: string
		let writablePath: string | undefined
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
			const action = continuing ? "Continue" : "Start"
			prompt = workspace.phasePath
				? `${action} the task. Read ${workspace.taskPath} and ${workspace.phasePath}.`
				: `${action} the task. Read ${workspace.taskPath}.`
			launchPath = dirname(workspace.taskPath)
			writablePath = workspace.writablePath
		}

		const explicitlyRequested = Boolean(
			options.runner ||
			options.opencode ||
			options.claude ||
			process.env.AGENCY_RUNNER,
		)
		let runner =
			options.runner ??
			process.env.AGENCY_RUNNER ??
			(options.claude ? "claude" : "opencode")
		const claimant = process.env.AGENCY_CLAIMANT ?? process.env.USER ?? "agency"
		const sessionId =
			process.env.AGENCY_SESSION_ID ?? `${process.pid}-${Date.now()}`
		const resume =
			process.env.AGENCY_SESSION_ID !== undefined ||
			(Boolean(options.auto) && continuing)
		const variables = {
			prompt: options.auto ? prompt : "",
			workbase: root,
			target: targetNodeId(target),
			task: target.kind === "epic" ? "" : target.taskId,
			phase: target.kind === "phase" ? target.phaseId : "",
			claimant,
			sessionId,
			claimRevision: "",
		}
		let resolved = resolveRunnerCommand(
			runner,
			config.runners,
			variables,
			resume,
			options.auto,
		)
		let cli = resolved.argv[0]!
		let available = yield* fs.runCommand(["which", cli], {
			captureOutput: true,
		})
		if (
			available.exitCode !== 0 &&
			!explicitlyRequested &&
			runner === "opencode"
		) {
			runner = "claude"
			resolved = resolveRunnerCommand(
				runner,
				config.runners,
				variables,
				resume,
				options.auto,
			)
			cli = resolved.argv[0]!
			available = yield* fs.runCommand(["which", cli], { captureOutput: true })
		}
		if (available.exitCode !== 0) {
			return yield* Effect.fail(new Error(`${cli} CLI tool not found`))
		}
		resolved = resolveRunnerCommand(
			runner,
			config.runners,
			variables,
			resume,
			options.auto,
		)
		cli = resolved.argv[0]!
		const environment = {
			...resolved.environment,
			...runnerEnvironment(runner, variables),
		}
		if (writablePath) environment.AGENCY_WRITABLE_CHECKOUT = writablePath
		if (options.printCommand) {
			log(
				JSON.stringify(
					{
						cwd: launchPath,
						argv: resolved.argv,
						environment: printableEnvironment(environment),
					},
					null,
					2,
				),
			)
			return
		}
		if (target.kind === "phase") {
			const previousStatus = (yield* phases.show(
				target.taskId,
				target.phaseId,
				root,
			)).data.status
			if (options.force && isTerminalStatus(previousStatus)) {
				yield* phases.setStatus(target.taskId, target.phaseId, "open", root)
			}
			yield* phases.setStatus(target.taskId, target.phaseId, "working", root)
			if (options.force && isTerminalStatus(previousStatus)) {
				const result = {
					target: `phase/${target.taskId}/${target.phaseId}`,
					reopened: true,
					previousStatus,
					status: "working",
				}
				log(
					options.json
						? JSON.stringify(result)
						: `Reopened ${result.target} from ${previousStatus} as working`,
				)
			}
		} else if (target.kind === "task" && !target.multiPhase) {
			const task = yield* tasks.show(target.taskId, root)
			if ("phases" in task.data) {
				return yield* Effect.fail(
					new Error(`Task '${target.taskId}' is not an execution unit`),
				)
			}
			const previousStatus = task.data.status
			if (options.force && isTerminalStatus(previousStatus)) {
				yield* tasks.setStatus(target.taskId, "open", root)
			}
			yield* tasks.setStatus(target.taskId, "working", root)
			if (options.force && isTerminalStatus(previousStatus)) {
				const result = {
					target: `task/${target.taskId}`,
					reopened: true,
					previousStatus,
					status: "working",
				}
				log(
					options.json
						? JSON.stringify(result)
						: `Reopened ${result.target} from ${previousStatus} as working`,
				)
			}
		}
		for (const [key, value] of Object.entries(environment)) {
			process.env[key] = value
		}
		verboseLog(
			`Launching command: ${formatCommand(resolved.argv)} (cwd: ${launchPath})`,
		)
		try {
			launch(cli, resolved.argv, launchPath, environment)
		} finally {
			for (const key of Object.keys(environment)) {
				const previous = previousEnvironment[key]
				if (previous === undefined) delete process.env[key]
				else process.env[key] = previous
			}
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

		let taskId = options.taskId
		let phaseId = options.phaseId
		if (taskId) {
			const task = yield* tasks.show(taskId, root)
			taskId = task.id
			if (phaseId) phaseId = (yield* phases.show(task.id, phaseId, root)).id
		} else if (options.directory && !isDirectory) {
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
Usage: agency work [<directory-or-task-id> | --epic <epic-id>] [--runner <name>] [--auto]
       agency work prepare [target] [--dry-run] [--json]

Launch an agent for an epic, task, or phase. With no directory, select one
interactively. A positional argument resolves as a directory first, then as a task
ID. Use '.' for the current directory. Outside a workbase, select a registered
workbase first. Managed OpenCode launches receive whole-workbase access through
Agency's project plugin; Agency context remains authoritative for writes.

The prepare subcommand resolves and materializes an execution workspace without
launching an agent or changing lifecycle status. --dry-run reports planned Git
changes without fetching, creating branches, or creating worktrees.

Options:
  --epic <id>          Work on an epic
  --task <id>          Work on a task
  --phase <id>         Work on a phase selected with --task
  --workbase <target>  Select a workbase by ID, name, or path
  --cwd <path>         Resolve context from a specific directory
  --runner <name>      Select a configured runner or built-in preset
  --auto               Send the generated context prompt to the runner
  --print-command      Print cwd, argv, and non-secret environment without launch
  --opencode           Require the OpenCode preset
  --claude             Require the Claude Code preset
  --force              Override readiness; reopen terminal execution units
  --no-input           Never open an interactive selector

Without interactive input, provide an explicit workbase or cwd and an entity
selector. Workbase and target selection otherwise fail.
`
