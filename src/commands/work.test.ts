import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { FileSystemService } from "../services/FileSystemService"
import { WorkbaseService } from "../services/WorkbaseService"
import { EpicService } from "../services/EpicService"
import { TaskService } from "../services/TaskService"
import { PhaseService } from "../services/PhaseService"
import { WorktreeService } from "../services/WorktreeService"
import { ClaimService } from "../services/ClaimService"
import { ReadinessService } from "../services/ReadinessService"
import { IntegrationService } from "../services/IntegrationService"
import { captureErrors, captureLogs } from "../test-utils"
import { work, workPrepare } from "./work"
import type { PickWorkTarget } from "../workbase/work-target"
import type { PickWorkbase } from "../workbase/workbase-choice"
import type { Progress } from "../utils/progress"

type ExecutionWorkspace = Effect.Effect.Success<
	ReturnType<WorktreeService["materialize"]>
>

const singlePhaseWorkspace: ExecutionWorkspace = {
	root: "/workbase",
	taskPath: "/workbase/tasks/example/TASK.md",
	phasePath: null,
	codePath: "/workbase/tasks/example/code",
	writablePath: "/workbase/tasks/example/code/agency",
	repo: "agency",
	repos: [],
	dryRun: false,
	checkouts: [],
	operations: [],
}

const multiPhaseWorkspace: ExecutionWorkspace = {
	root: "/workbase",
	taskPath: "/workbase/tasks/example/TASK.md",
	phasePath: "/workbase/tasks/example/phases/implementation/PHASE.md",
	codePath: "/workbase/tasks/example/phases/implementation/code",
	writablePath: "/workbase/tasks/example/phases/implementation/code/agency",
	repo: "agency",
	repos: [],
	dryRun: false,
	checkouts: [],
	operations: [],
}

interface HarnessOptions {
	readonly workspace?: ExecutionWorkspace
	readonly materializeError?: Error
	readonly available?: Readonly<Record<string, boolean>>
	readonly chooserCommand?: readonly string[]
	readonly runners?: Record<
		string,
		{
			command: readonly [string, ...string[]]
			resumeCommand?: readonly [string, ...string[]]
			environment?: Record<string, string>
		}
	>
	readonly multiPhaseTasks?: readonly string[]
	readonly epicRecords?: readonly any[]
	readonly taskRecords?: readonly any[]
	readonly phaseRecords?: readonly any[]
	readonly outsideWorkbase?: boolean
	readonly registeredWorkbases?: readonly string[]
	readonly existingDirectories?: readonly string[]
	readonly guardError?: Error
	readonly readyTargetIds?: readonly string[]
}

const createHarness = (options: HarnessOptions = {}) => {
	const events: string[] = []
	const probes: string[] = []
	const statusUpdates: string[] = []
	const shownTasks: string[] = []
	const progressUpdates: string[] = []
	let integrationSyncs = 0
	const guards: Array<{ target: string; override?: boolean }> = []
	const launches: Array<{
		cli: string
		args: readonly string[]
		cwd: string
	}> = []
	const launchEnvironments: Array<Readonly<Record<string, string>>> = []
	const materializeOptions: Array<
		Parameters<WorktreeService["materialize"]>[3]
	> = []
	const worktrees = {
		materialize: (
			_taskId: string,
			_phaseId?: string,
			_root?: string,
			commandOptions?: Parameters<WorktreeService["materialize"]>[3],
		) => {
			events.push("materialize")
			materializeOptions.push(commandOptions)
			return options.materializeError
				? Effect.fail(options.materializeError)
				: Effect.succeed(options.workspace ?? singlePhaseWorkspace)
		},
	}
	const workbase = {
		discover: (path: string) =>
			options.outsideWorkbase && path === "/outside"
				? Effect.fail({
						_tag: "WorkbaseNotFoundError" as const,
						message: "No Agency workbase found from /outside",
					})
				: Effect.succeed("/workbase"),
		listRegistered: () => Effect.succeed(options.registeredWorkbases ?? []),
		getDefault: () => Effect.succeed(undefined),
		loadConfig: () =>
			Effect.succeed({
				root: "/workbase",
				config: {
					version: 2 as const,
					chooserCommand: options.chooserCommand,
					runners: options.runners,
				},
			}),
	}
	const epics = {
		show: (id: string) =>
			Effect.succeed({
				id,
				path: `/workbase/epics/${id}/EPIC.md`,
				data: { tasks: [] },
			}),
		list: () => Effect.succeed(options.epicRecords ?? []),
	}
	const tasks = {
		show: (id: string) => {
			shownTasks.push(id)
			return Effect.succeed({
				id,
				path: `/workbase/tasks/${id}/TASK.md`,
				data: options.multiPhaseTasks?.includes(id)
					? { phases: [] }
					: { repo: "agency", branch: `task/${id}`, base: "main" },
			})
		},
		list: () => Effect.succeed(options.taskRecords ?? []),
		setStatus: (id: string, status: string) => {
			statusUpdates.push(`task:${id}:${status}`)
			return Effect.void
		},
	}
	const phases = {
		show: (taskId: string, id: string) =>
			Effect.succeed({
				taskId,
				id,
				path: `/workbase/tasks/${taskId}/phases/${id}/PHASE.md`,
				data: { repo: "agency", branch: `task/${id}`, base: "main" },
			}),
		list: () => Effect.succeed(options.phaseRecords ?? []),
		setStatus: (taskId: string, id: string, status: string) => {
			statusUpdates.push(`phase:${taskId}:${id}:${status}`)
			return Effect.void
		},
	}
	const claims = {
		inspect: (taskId: string, phaseId?: string) =>
			Effect.succeed({
				target: {
					kind: phaseId ? "phase" : "task",
					taskId,
					phaseId,
					path: phaseId
						? `/workbase/tasks/${taskId}/phases/${phaseId}/PHASE.md`
						: `/workbase/tasks/${taskId}/TASK.md`,
					label: phaseId ? `phase '${taskId}/${phaseId}'` : `task '${taskId}'`,
				},
				revision: "0".repeat(64),
				data: {},
			}),
		claim: (input: { taskId: string; phaseId?: string }) => {
			statusUpdates.push(
				input.phaseId
					? `phase:${input.taskId}:${input.phaseId}:working`
					: `task:${input.taskId}:working`,
			)
			return Effect.succeed({ revision: "1".repeat(64) })
		},
	}
	const readiness = {
		getReadyWorkTargetIds: () =>
			Effect.succeed(
				new Set(
					options.readyTargetIds ?? [
						...(options.epicRecords ?? []).map(
							(record: any) => `epic:${record.id}`,
						),
						...(options.taskRecords ?? []).map((record: any) =>
							"phases" in record.data
								? `task:${record.id}`
								: `execution-unit:task/${record.id}`,
						),
						...(options.phaseRecords ?? []).map(
							(record: any) =>
								`execution-unit:phase/${record.taskId}/${record.id}`,
						),
					],
				),
			),
		guardWorkTarget: (target: string, _root: string, override?: boolean) => {
			if (options.guardError || override) events.push("guard")
			guards.push({ target, override })
			return options.guardError && !override
				? Effect.fail(options.guardError)
				: Effect.void
		},
	}
	const integrations = {
		sync: () => {
			integrationSyncs += 1
			return Effect.succeed({ root: "/workbase", files: [] })
		},
	}
	const fs = {
		isDirectory: (path: string) =>
			Effect.succeed(options.existingDirectories?.includes(path) ?? true),
		runCommand: (args: readonly string[]) => {
			const cli = args[1]!
			events.push(`probe:${cli}`)
			probes.push(cli)
			return Effect.succeed({
				exitCode: options.available?.[cli] === false ? 1 : 0,
				stdout: "",
				stderr: "",
			})
		},
	}
	const launch = (
		cli: string,
		args: readonly string[],
		cwd: string,
		environment: Readonly<Record<string, string>>,
	) => {
		events.push(`launch:${cli}`)
		launches.push({ cli, args, cwd })
		launchEnvironments.push(environment)
	}
	const defaultPick: PickWorkTarget = () => Effect.succeed(null)
	const defaultPickWorkbase: PickWorkbase = () => Effect.succeed(null)
	const progress: Progress = {
		start: (message) => progressUpdates.push(`start:${message}`),
		succeed: (message) => progressUpdates.push(`succeed:${message}`),
		fail: (message) => progressUpdates.push(`fail:${message}`),
	}
	const run = (
		commandOptions: Parameters<typeof work>[0],
		pick: PickWorkTarget = defaultPick,
		pickBase: PickWorkbase = defaultPickWorkbase,
	) =>
		Effect.runPromise(
			work(commandOptions, launch, pick, progress, pickBase).pipe(
				Effect.provideService(WorktreeService, worktrees as never),
				Effect.provideService(FileSystemService, fs as never),
				Effect.provideService(WorkbaseService, workbase as never),
				Effect.provideService(EpicService, epics as never),
				Effect.provideService(TaskService, tasks as never),
				Effect.provideService(PhaseService, phases as never),
				Effect.provideService(ClaimService, claims as never),
				Effect.provideService(ReadinessService, readiness as never),
				Effect.provideService(IntegrationService, integrations as never),
			) as Effect.Effect<void, unknown, never>,
		)
	const runPrepare = (commandOptions: Parameters<typeof workPrepare>[0]) =>
		Effect.runPromise(
			workPrepare(commandOptions).pipe(
				Effect.provideService(WorktreeService, worktrees as never),
				Effect.provideService(FileSystemService, fs as never),
				Effect.provideService(WorkbaseService, workbase as never),
				Effect.provideService(TaskService, tasks as never),
				Effect.provideService(PhaseService, phases as never),
			) as Effect.Effect<void, unknown, never>,
		)

	return {
		events,
		probes,
		launches,
		launchEnvironments,
		materializeOptions,
		statusUpdates,
		shownTasks,
		progressUpdates,
		guards,
		get integrationSyncs() {
			return integrationSyncs
		},
		run,
		runPrepare,
	}
}

describe("work command", () => {
	test("reconciles managed integration files before preparing work", async () => {
		const harness = createHarness()

		await harness.run({ taskId: "example", opencode: true })

		expect(harness.integrationSyncs).toBe(1)
	})

	test("guards execution targets before materialization and honors --force", async () => {
		const blocked = createHarness({ guardError: new Error("blocked") })
		await expect(
			blocked.run({ taskId: "example", opencode: true }),
		).rejects.toThrow("blocked")
		expect(blocked.events).toEqual(["guard"])
		expect(blocked.guards).toEqual([
			{ target: "execution-unit:task/example", override: undefined },
		])

		const forced = createHarness({ guardError: new Error("blocked") })
		await forced.run({ taskId: "example", opencode: true, force: true })
		expect(forced.events).toEqual([
			"guard",
			"materialize",
			"probe:opencode",
			"launch:opencode",
		])
		expect(forced.guards[0]).toEqual({
			target: "execution-unit:task/example",
			override: true,
		})
	})

	test("offers only graph-ready targets to the interactive chooser", async () => {
		const harness = createHarness({
			taskRecords: [
				{
					id: "ready",
					path: "/workbase/tasks/ready/TASK.md",
					data: { status: "open" },
				},
				{
					id: "blocked",
					path: "/workbase/tasks/blocked/TASK.md",
					data: { status: "open" },
				},
			],
			readyTargetIds: ["execution-unit:task/ready"],
		})
		let labels: readonly string[] = []
		const pick: PickWorkTarget = (choices) => {
			labels = choices.map((choice) => choice.plainLabel)
			return Effect.succeed(null)
		}

		await harness.run({ cwd: "/workbase" }, pick)
		expect(labels).toEqual(["[open] task ready"])
	})

	test("prepares without launching or changing lifecycle status", async () => {
		const harness = createHarness({ existingDirectories: [] })

		await captureLogs(() =>
			harness.runPrepare({
				cwd: "/workbase",
				directory: "example",
				json: true,
				dryRun: true,
			}),
		)

		expect(harness.events).toEqual(["materialize"])
		expect(harness.launches).toEqual([])
		expect(harness.statusUpdates).toEqual([])
		expect(harness.materializeOptions[0]).toMatchObject({
			json: true,
			dryRun: true,
		})
	})

	test("launches an epic agent from an epic directory", async () => {
		const harness = createHarness()

		await harness.run({
			cwd: "/workbase/epics/delivery",
			directory: ".",
			opencode: true,
		})

		expect(harness.events).toEqual(["probe:opencode", "launch:opencode"])
		expect(harness.launches[0]).toEqual({
			cli: "opencode",
			args: [
				"opencode",
				"--prompt",
				"Work on the epic. Read /workbase/epics/delivery/EPIC.md.",
			],
			cwd: "/workbase/epics/delivery",
		})
	})

	test("resolves an existing positional path before treating it as a task ID", async () => {
		const harness = createHarness({
			existingDirectories: ["/workbase/tasks/delivery"],
		})

		await harness.run({
			cwd: "/workbase/tasks/delivery",
			directory: ".",
			opencode: true,
		})

		expect(harness.shownTasks).toEqual(["delivery"])
		expect(harness.launches[0]?.cwd).toBe(singlePhaseWorkspace.writablePath)
	})

	test("treats a positional value as a task ID when it is not a directory", async () => {
		const harness = createHarness({ existingDirectories: [] })

		await harness.run({
			cwd: "/workbase",
			directory: "delivery",
			opencode: true,
		})

		expect(harness.shownTasks).toEqual(["delivery"])
		expect(harness.launches[0]?.cwd).toBe(singlePhaseWorkspace.writablePath)
	})

	test("launches a multi-phase task agent without materializing", async () => {
		const harness = createHarness({ multiPhaseTasks: ["delivery"] })

		await harness.run({
			cwd: "/workbase/tasks/delivery",
			directory: ".",
			opencode: true,
		})

		expect(harness.events).toEqual(["probe:opencode", "launch:opencode"])
		expect(harness.launches[0]).toEqual({
			cli: "opencode",
			args: [
				"opencode",
				"--prompt",
				"Work on the task. Read /workbase/tasks/delivery/TASK.md.",
			],
			cwd: "/workbase/tasks/delivery",
		})
	})

	test("infers a phase from a nested checkout directory", async () => {
		const harness = createHarness({ workspace: multiPhaseWorkspace })

		await harness.run({
			cwd: "/workbase/tasks/example/phases/implementation/code/agency/src",
			directory: ".",
			opencode: true,
		})

		expect(harness.events).toEqual([
			"materialize",
			"probe:opencode",
			"launch:opencode",
		])
		expect(harness.launches[0]).toEqual({
			cli: "opencode",
			args: [
				"opencode",
				"--prompt",
				"Start the task. Read /workbase/tasks/example/TASK.md and /workbase/tasks/example/phases/implementation/PHASE.md.",
			],
			cwd: multiPhaseWorkspace.writablePath,
		})
		expect(harness.statusUpdates).toEqual([
			"phase:example:implementation:working",
		])
	})

	test("infers a single-phase task from a nested checkout directory", async () => {
		const harness = createHarness()

		await harness.run({
			cwd: "/workbase/tasks/example/code/agency/src",
			directory: ".",
			opencode: true,
		})

		expect(harness.events[0]).toBe("materialize")
		expect(harness.launches[0]?.cwd).toBe(singlePhaseWorkspace.writablePath)
	})

	test("selects a target when no directory is provided", async () => {
		const phase = {
			taskId: "delivery",
			id: "build",
			path: "/workbase/tasks/delivery/phases/build/PHASE.md",
			data: {},
		}
		const harness = createHarness({
			workspace: multiPhaseWorkspace,
			taskRecords: [
				{
					id: "delivery",
					path: "/workbase/tasks/delivery/TASK.md",
					data: { phases: [{ id: "build" }] },
				},
			],
			phaseRecords: [phase],
		})
		const pick: PickWorkTarget = (choices) =>
			Effect.succeed(
				choices.find((choice) => choice.label.includes("build"))!.target,
			)

		await harness.run({ cwd: "/workbase/tasks/example", opencode: true }, pick)

		expect(harness.events).toEqual([
			"materialize",
			"probe:opencode",
			"launch:opencode",
		])
		expect(harness.launches[0]?.cwd).toBe(multiPhaseWorkspace.writablePath)
	})

	test("requires an explicit target when input is disabled", async () => {
		const harness = createHarness()

		await expect(
			harness.run({
				cwd: "/workbase",
				opencode: true,
				inputAllowed: false,
			}),
		).rejects.toThrow("provide a directory, task ID, or --epic")
		expect(harness.events).toEqual([])
	})

	test("runs an explicit target when input is disabled", async () => {
		const harness = createHarness({ existingDirectories: [] })

		await harness.run({
			cwd: "/workbase",
			directory: "example",
			opencode: true,
			inputAllowed: false,
		})

		expect(harness.events).toEqual([
			"materialize",
			"probe:opencode",
			"launch:opencode",
		])
	})

	test("selects a registered workbase when local discovery fails", async () => {
		const harness = createHarness({
			outsideWorkbase: true,
			registeredWorkbases: ["/first", "/workbase"],
		})
		const selections: string[][] = []
		const pickBase: PickWorkbase = (workbases) => {
			selections.push([...workbases])
			return Effect.succeed("/workbase")
		}

		await harness.run(
			{ cwd: "/outside", taskId: "example", opencode: true },
			undefined,
			pickBase,
		)

		expect(selections).toEqual([["/first", "/workbase"]])
		expect(harness.events).toEqual([
			"materialize",
			"probe:opencode",
			"launch:opencode",
		])
	})

	test("does not select a registered workbase when input is disabled", async () => {
		const harness = createHarness({
			outsideWorkbase: true,
			registeredWorkbases: ["/workbase"],
			existingDirectories: [],
		})

		await expect(
			harness.run({
				cwd: "/outside",
				directory: "example",
				opencode: true,
				inputAllowed: false,
			}),
		).rejects.toThrow("provide an explicit path or run Agency from a workbase")
		expect(harness.events).toEqual([])
	})

	test("explains how to register a workbase when none are known", async () => {
		const harness = createHarness({ outsideWorkbase: true })

		await expect(harness.run({ cwd: "/outside" })).rejects.toThrow(
			"agency workbase add <path>",
		)
		expect(harness.events).toEqual([])
	})

	test("passes the configured chooser command to the shared picker", async () => {
		const harness = createHarness({
			chooserCommand: ["gum", "filter"],
			epicRecords: [
				{
					id: "delivery",
					path: "/workbase/epics/delivery/EPIC.md",
					data: { tasks: [] },
				},
			],
		})
		let command: readonly string[] | undefined
		const pick: PickWorkTarget = (_choices, chooserCommand) => {
			command = chooserCommand
			return Effect.succeed(null)
		}

		await harness.run({ cwd: "/workbase" }, pick)

		expect(command).toEqual(["gum", "filter"])
		expect(harness.launches).toEqual([])
	})

	test("rejects conflicting agent flags before materialization", async () => {
		const harness = createHarness()

		await expect(
			harness.run({ taskId: "example", opencode: true, claude: true }),
		).rejects.toThrow("Cannot combine --runner, --opencode, and --claude")
		expect(harness.events).toEqual([])
	})

	test("rejects combining explicit epic and task targets", async () => {
		const harness = createHarness()

		await expect(
			harness.run({ epicId: "delivery", taskId: "example" }),
		).rejects.toThrow("Cannot combine --epic")
		expect(harness.events).toEqual([])
	})

	test("launches OpenCode in the writable checkout with explicit context", async () => {
		const harness = createHarness()

		await harness.run({ taskId: "example", opencode: true })

		expect(harness.events).toEqual([
			"materialize",
			"probe:opencode",
			"launch:opencode",
		])
		expect(harness.launches).toEqual([
			{
				cli: "opencode",
				args: [
					"opencode",
					"--prompt",
					"Start the task. Read /workbase/tasks/example/TASK.md.",
				],
				cwd: singlePhaseWorkspace.writablePath,
			},
		])
		expect(harness.statusUpdates).toEqual(["task:example:working"])
		expect(harness.progressUpdates).toEqual([
			"start:Preparing workspace...",
			"succeed:Workspace ready",
		])
	})

	test("resumes OpenCode deterministically when a session identity exists", async () => {
		const harness = createHarness({ workspace: multiPhaseWorkspace })
		process.env.AGENCY_SESSION_ID = "existing-session"
		try {
			await harness.run({
				taskId: "example",
				phaseId: "implementation",
				opencode: true,
			})
		} finally {
			delete process.env.AGENCY_SESSION_ID
		}

		expect(harness.launches[0]).toEqual({
			cli: "opencode",
			args: [
				"opencode",
				"--continue",
				"--prompt",
				"Start the task. Read /workbase/tasks/example/TASK.md and /workbase/tasks/example/phases/implementation/PHASE.md.",
			],
			cwd: multiPhaseWorkspace.writablePath,
		})
	})

	test("expands a named runner with shared context and claim identity", async () => {
		const harness = createHarness({
			available: { codex: true },
			runners: {
				custom: {
					command: ["codex", "--task", "{task}", "{prompt}"],
					environment: {
						CUSTOM_TARGET: "{target}",
						AGENCY_TARGET: "cannot-override",
					},
				},
			},
		})

		await harness.run({ taskId: "example", runner: "custom" })

		expect(harness.probes).toEqual(["codex"])
		expect(harness.launches[0]).toEqual({
			cli: "codex",
			args: [
				"codex",
				"--task",
				"example",
				"Start the task. Read /workbase/tasks/example/TASK.md.",
			],
			cwd: singlePhaseWorkspace.writablePath,
		})
		expect(harness.launchEnvironments[0]).toMatchObject({
			AGENCY_RUNNER: "custom",
			AGENCY_CLAIMANT: process.env.USER ?? "agency",
			AGENCY_WORKBASE: "/workbase",
			AGENCY_TARGET: "execution-unit:task/example",
			AGENCY_TASK_ID: "example",
			AGENCY_PHASE_ID: "",
			AGENCY_CLAIM_REVISION: "1".repeat(64),
			CUSTOM_TARGET: "execution-unit:task/example",
		})
	})

	test("prints the exact command contract without launching and omits secrets", async () => {
		const harness = createHarness({
			available: { agent: true },
			runners: {
				custom: {
					command: ["agent", "{prompt}"],
					environment: {
						VISIBLE: "{task}",
						API_TOKEN: "do-not-print",
					},
				},
			},
		})

		const output = await captureLogs(() =>
			harness.run({
				taskId: "example",
				runner: "custom",
				printCommand: true,
			}),
		)
		const printed = JSON.parse(output.join("\n"))

		expect(harness.launches).toEqual([])
		expect(printed.cwd).toBe(singlePhaseWorkspace.writablePath)
		expect(printed.argv).toEqual([
			"agent",
			"Start the task. Read /workbase/tasks/example/TASK.md.",
		])
		expect(printed.environment.VISIBLE).toBe("example")
		expect(printed.environment.API_TOKEN).toBeUndefined()
	})

	test("automatically falls back to Claude", async () => {
		const harness = createHarness({ available: { opencode: false } })

		await harness.run({ taskId: "example" })

		expect(harness.probes).toEqual(["opencode", "claude"])
		expect(harness.launches[0]).toEqual({
			cli: "claude",
			args: ["claude", "Start the task. Read /workbase/tasks/example/TASK.md."],
			cwd: singlePhaseWorkspace.writablePath,
		})
	})

	test("does not fall back when OpenCode is explicitly required", async () => {
		const harness = createHarness({ available: { opencode: false } })

		await expect(
			harness.run({ taskId: "example", opencode: true }),
		).rejects.toThrow("opencode CLI tool not found")
		expect(harness.probes).toEqual(["opencode"])
		expect(harness.launches).toEqual([])
		expect(harness.statusUpdates).toEqual([])
	})

	test("launches explicitly requested Claude", async () => {
		const harness = createHarness()

		await harness.run({ taskId: "example", claude: true })

		expect(harness.probes).toEqual(["claude"])
		expect(harness.launches[0]).toEqual({
			cli: "claude",
			args: ["claude", "Start the task. Read /workbase/tasks/example/TASK.md."],
			cwd: singlePhaseWorkspace.writablePath,
		})
	})

	test("fails when neither agent tool is available", async () => {
		const harness = createHarness({
			available: { opencode: false, claude: false },
		})

		await expect(harness.run({ taskId: "example" })).rejects.toThrow(
			"claude CLI tool not found",
		)
		expect(harness.probes).toEqual(["opencode", "claude"])
		expect(harness.launches).toEqual([])
	})

	test("does not probe or launch when materialization fails", async () => {
		const harness = createHarness({
			materializeError: new Error("materialization failed"),
		})

		await expect(harness.run({ taskId: "example" })).rejects.toThrow(
			"materialization failed",
		)
		expect(harness.events).toEqual(["materialize"])
		expect(harness.progressUpdates).toEqual([
			"start:Preparing workspace...",
			"fail:Workspace preparation failed",
		])
	})

	test("respects silent and verbose logging options", async () => {
		const verboseHarness = createHarness()
		const verboseLogs = await captureErrors(() =>
			verboseHarness.run({ taskId: "example", verbose: true }),
		)
		expect(verboseLogs).toEqual([
			"Launching command: opencode --prompt 'Start the task. Read /workbase/tasks/example/TASK.md.' (cwd: /workbase/tasks/example/code/agency)",
		])
		expect(verboseHarness.materializeOptions[0]?.verbose).toBe(true)

		const silentHarness = createHarness()
		const silentLogs = await captureErrors(() =>
			silentHarness.run({
				taskId: "example",
				verbose: true,
				silent: true,
			}),
		)
		expect(silentLogs).toEqual([])
	})
})
