import { Effect, Layer } from "effect"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FileSystemService } from "../src/services/FileSystemService"
import { PhaseService } from "../src/services/PhaseService"
import { TaskService } from "../src/services/TaskService"
import { WorkbaseService } from "../src/services/WorkbaseService"
import {
	GitVersionControlService,
	VersionControlService,
} from "../src/services/VersionControlService"

const sampleCount = 7
const BenchmarkLayer = Layer.mergeAll(
	FileSystemService.Default,
	WorkbaseService.Default,
	TaskService.Default,
	PhaseService.Default,
	GitVersionControlService.Default,
	VersionControlService.Default,
)

const runEffect = <A>(effect: Effect.Effect<A, unknown, any>) =>
	Effect.runPromise(
		effect.pipe(Effect.provide(BenchmarkLayer)) as Effect.Effect<
			A,
			unknown,
			never
		>,
	)

const createWorkbase = async (taskCount: number, phasesPerTask: number) => {
	const root = await mkdtemp(join(tmpdir(), "agency-phase-benchmark-"))
	await mkdir(join(root, "repos/agency"), { recursive: true })
	await Bun.write(join(root, "agency.json"), '{"version":2}\n')
	for (let taskIndex = 0; taskIndex < taskCount; taskIndex += 1) {
		const taskId = `task-${taskIndex}`
		const taskPath = join(root, "tasks", taskId)
		await mkdir(taskPath, { recursive: true })
		const phaseIds = Array.from(
			{ length: phasesPerTask },
			(_, phaseIndex) => `phase-${phaseIndex}`,
		)
		await Bun.write(
			join(taskPath, "TASK.md"),
			`---\nticketUrl: null\nphases:\n${phaseIds.map((id) => `  - id: ${id}`).join("\n")}\n---\n\n# ${taskId}\n`,
		)
		await Promise.all(
			phaseIds.map(async (phaseId) => {
				const phasePath = join(taskPath, "phases", phaseId)
				await mkdir(phasePath, { recursive: true })
				await Bun.write(
					join(phasePath, "PHASE.md"),
					`---\nrepo: agency\nbranch: ${taskId}/${phaseId}\nbase: main\npr: null\nstatus: open\n---\n\n# ${phaseId}\n`,
				)
			}),
		)
	}
	return root
}

const median = (samples: readonly number[]) =>
	[...samples].sort((left, right) => left - right)[
		Math.floor(samples.length / 2)
	]!

const measure = async (operation: () => Promise<unknown>) => {
	const coldStart = performance.now()
	await operation()
	const coldMs = performance.now() - coldStart
	const samples: number[] = []
	for (let index = 0; index < sampleCount; index += 1) {
		const start = performance.now()
		await operation()
		samples.push(performance.now() - start)
	}
	return {
		coldMs: Number(coldMs.toFixed(2)),
		warmMedianMs: Number(median(samples).toFixed(2)),
		warmSamplesMs: samples.map((sample) => Number(sample.toFixed(2))),
	}
}

const scenarios = [
	{ name: "small", taskCount: 4, phasesPerTask: 4 },
	{ name: "large", taskCount: 50, phasesPerTask: 10 },
]

const results: Record<string, unknown> = {}
for (const scenario of scenarios) {
	const root = await createWorkbase(scenario.taskCount, scenario.phasesPerTask)
	try {
		results[scenario.name] = {
			taskCount: scenario.taskCount,
			phasesPerTask: scenario.phasesPerTask,
			show: await measure(() =>
				runEffect(
					PhaseService.pipe(
						Effect.flatMap((service) =>
							service.show(
								"task-0",
								`phase-${scenario.phasesPerTask - 1}`,
								root,
							),
						),
					),
				),
			),
			list: await measure(() =>
				runEffect(
					PhaseService.pipe(
						Effect.flatMap((service) => service.list("task-0", root)),
					),
				),
			),
			validate: await measure(() =>
				runEffect(
					WorkbaseService.pipe(
						Effect.flatMap((service) => service.validate(root)),
					),
				),
			),
		}
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}

console.log(JSON.stringify({ sampleCount, scenarios: results }, null, 2))
