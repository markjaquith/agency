import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { FileSystemService } from "../services/FileSystemService"
import { WorktreeService } from "../services/WorktreeService"
import { captureLogs } from "../test-utils"
import { work } from "./work"

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
	readonly available?: Partial<Record<"opencode" | "claude", boolean>>
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
	const run = (commandOptions: Parameters<typeof work>[0]) =>
		Effect.runPromise(
			work(commandOptions, launch).pipe(
				Effect.provideService(WorktreeService, worktrees as never),
				Effect.provideService(FileSystemService, fs as never),
			) as Effect.Effect<void, unknown, never>,
		)

	return { events, probes, launches, run }
}

describe("work command", () => {
	test("requires a task ID before materialization", async () => {
		const harness = createHarness()

		await expect(harness.run({})).rejects.toThrow("Task ID is required")
		expect(harness.events).toEqual([])
	})

	test("rejects conflicting agent flags before materialization", async () => {
		const harness = createHarness()

		await expect(
			harness.run({ taskId: "example", opencode: true, claude: true }),
		).rejects.toThrow("Cannot use both --opencode and --claude")
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
