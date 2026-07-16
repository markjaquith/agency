import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { FileSystemService } from "../services/FileSystemService"
import { WorkbaseService } from "../services/WorkbaseService"
import { EpicService } from "../services/EpicService"
import { TaskService } from "../services/TaskService"
import { PhaseService } from "../services/PhaseService"
import { WorktreeService } from "../services/WorktreeService"
import { captureLogs } from "../test-utils"
import { work } from "./work"
import type { PickWorkTarget } from "../workbase/work-target"

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
}

const multiPhaseWorkspace: ExecutionWorkspace = {
	root: "/workbase",
	taskPath: "/workbase/tasks/example/TASK.md",
	phasePath: "/workbase/tasks/example/phases/implementation/PHASE.md",
	codePath: "/workbase/tasks/example/phases/implementation/code",
	writablePath: "/workbase/tasks/example/phases/implementation/code/agency",
	repo: "agency",
	repos: [],
}

interface HarnessOptions {
	readonly workspace?: ExecutionWorkspace
	readonly materializeError?: Error
	readonly available?: Partial<Record<"opencode" | "claude" | "fzf", boolean>>
	readonly multiPhaseTasks?: readonly string[]
	readonly epicRecords?: readonly any[]
	readonly taskRecords?: readonly any[]
	readonly phaseRecords?: readonly any[]
}

const createHarness = (options: HarnessOptions = {}) => {
	const events: string[] = []
	const probes: string[] = []
	const launches: Array<{
		cli: string
		args: readonly string[]
		cwd: string
	}> = []
	const worktrees = {
		materialize: () => {
			events.push("materialize")
			return options.materializeError
				? Effect.fail(options.materializeError)
				: Effect.succeed(options.workspace ?? singlePhaseWorkspace)
		},
	}
	const workbase = {
		discover: () => Effect.succeed("/workbase"),
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
		show: (id: string) =>
			Effect.succeed({
				id,
				path: `/workbase/tasks/${id}/TASK.md`,
				data: options.multiPhaseTasks?.includes(id)
					? { phases: [] }
					: { repo: "agency", branch: `task/${id}`, base: "main" },
			}),
		list: () => Effect.succeed(options.taskRecords ?? []),
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
	}
	const fs = {
		runCommand: (args: readonly string[]) => {
			const cli = args[1] as "opencode" | "claude"
			events.push(`probe:${cli}`)
			probes.push(cli)
			return Effect.succeed({
				exitCode: options.available?.[cli] === false ? 1 : 0,
				stdout: "",
				stderr: "",
			})
		},
	}
	const launch = (cli: string, args: readonly string[], cwd: string) => {
		events.push(`launch:${cli}`)
		launches.push({ cli, args, cwd })
	}
	const defaultPick: PickWorkTarget = () => Effect.succeed(null)
	const run = (
		commandOptions: Parameters<typeof work>[0],
		pick: PickWorkTarget = defaultPick,
	) =>
		Effect.runPromise(
			work(commandOptions, launch, pick).pipe(
				Effect.provideService(WorktreeService, worktrees as never),
				Effect.provideService(FileSystemService, fs as never),
				Effect.provideService(WorkbaseService, workbase as never),
				Effect.provideService(EpicService, epics as never),
				Effect.provideService(TaskService, tasks as never),
				Effect.provideService(PhaseService, phases as never),
			) as Effect.Effect<void, unknown, never>,
		)

	return { events, probes, launches, run }
}

describe("work command", () => {
	test("launches an epic agent from an epic directory", async () => {
		const harness = createHarness()

		await harness.run({ cwd: "/workbase/epics/delivery", opencode: true })

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

	test("launches a multi-phase task agent without materializing", async () => {
		const harness = createHarness({ multiPhaseTasks: ["delivery"] })

		await harness.run({ cwd: "/workbase/tasks/delivery", opencode: true })

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
			opencode: true,
		})

		expect(harness.events).toEqual([
			"materialize",
			"probe:opencode",
			"launch:opencode",
		])
		expect(harness.launches[0]?.args).toContain(
			"Start the task. Read /workbase/tasks/example/TASK.md and /workbase/tasks/example/phases/implementation/PHASE.md.",
		)
	})

	test("infers a single-phase task from a nested checkout directory", async () => {
		const harness = createHarness()

		await harness.run({
			cwd: "/workbase/tasks/example/code/agency/src",
			opencode: true,
		})

		expect(harness.events[0]).toBe("materialize")
		expect(harness.launches[0]?.cwd).toBe("/workbase/tasks/example/code/agency")
	})

	test("selects a target with fzf outside an entity directory", async () => {
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

		await harness.run({ cwd: "/workbase", opencode: true }, pick)

		expect(harness.events).toEqual([
			"probe:fzf",
			"materialize",
			"probe:opencode",
			"launch:opencode",
		])
		expect(harness.launches[0]?.cwd).toBe(
			"/workbase/tasks/example/phases/implementation/code/agency",
		)
	})

	test("prints the target tree when fzf is unavailable", async () => {
		const harness = createHarness({
			available: { fzf: false },
			epicRecords: [
				{
					id: "delivery",
					path: "/workbase/epics/delivery/EPIC.md",
					data: { tasks: [] },
				},
			],
		})

		const logs = await captureLogs(async () => {
			await expect(harness.run({ cwd: "/workbase" })).rejects.toThrow(
				"fzf is required",
			)
		})

		expect(logs).toEqual(["\x1b[35m\x1b[0m delivery"])
		expect(harness.launches).toEqual([])
	})

	test("rejects conflicting agent flags before materialization", async () => {
		const harness = createHarness()

		await expect(
			harness.run({ taskId: "example", opencode: true, claude: true }),
		).rejects.toThrow("Cannot use both --opencode and --claude")
		expect(harness.events).toEqual([])
	})

	test("rejects combining explicit epic and task targets", async () => {
		const harness = createHarness()

		await expect(
			harness.run({ epicId: "delivery", taskId: "example" }),
		).rejects.toThrow("Cannot combine --epic")
		expect(harness.events).toEqual([])
	})

	test("launches OpenCode in the writable checkout with the single-phase prompt", async () => {
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
				cwd: "/workbase/tasks/example/code/agency",
			},
		])
	})

	test("includes absolute task and phase paths in a multi-phase prompt", async () => {
		const harness = createHarness({ workspace: multiPhaseWorkspace })

		await harness.run({
			taskId: "example",
			phaseId: "implementation",
			opencode: true,
		})

		expect(harness.launches[0]?.args).toEqual([
			"opencode",
			"--prompt",
			"Start the task. Read /workbase/tasks/example/TASK.md and /workbase/tasks/example/phases/implementation/PHASE.md.",
		])
	})

	test("automatically falls back to Claude", async () => {
		const harness = createHarness({ available: { opencode: false } })

		await harness.run({ taskId: "example" })

		expect(harness.probes).toEqual(["opencode", "claude"])
		expect(harness.launches[0]).toEqual({
			cli: "claude",
			args: ["claude", "Start the task. Read /workbase/tasks/example/TASK.md."],
			cwd: "/workbase/tasks/example/code/agency",
		})
	})

	test("does not fall back when OpenCode is explicitly required", async () => {
		const harness = createHarness({ available: { opencode: false } })

		await expect(
			harness.run({ taskId: "example", opencode: true }),
		).rejects.toThrow("opencode CLI tool not found")
		expect(harness.probes).toEqual(["opencode"])
		expect(harness.launches).toEqual([])
	})

	test("launches explicitly requested Claude", async () => {
		const harness = createHarness()

		await harness.run({ taskId: "example", claude: true })

		expect(harness.probes).toEqual(["claude"])
		expect(harness.launches[0]).toEqual({
			cli: "claude",
			args: ["claude", "Start the task. Read /workbase/tasks/example/TASK.md."],
			cwd: "/workbase/tasks/example/code/agency",
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
	})

	test("respects silent and verbose logging options", async () => {
		const verboseHarness = createHarness()
		const verboseLogs = await captureLogs(() =>
			verboseHarness.run({ taskId: "example", verbose: true }),
		)
		expect(verboseLogs).toEqual([
			"Launching opencode in /workbase/tasks/example/code/agency",
		])

		const silentHarness = createHarness()
		const silentLogs = await captureLogs(() =>
			silentHarness.run({
				taskId: "example",
				verbose: true,
				silent: true,
			}),
		)
		expect(silentLogs).toEqual([])
	})
})
