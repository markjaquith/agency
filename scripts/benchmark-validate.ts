import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { FileSystemService } from "../src/services/FileSystemService"
import { WorkbaseService } from "../src/services/WorkbaseService"

const taskCount = Number(process.env.AGENCY_BENCHMARK_TASKS ?? 200)
const phaseCount = Number(process.env.AGENCY_BENCHMARK_PHASES ?? 10)
const sampleCount = 5

const median = (samples: readonly number[]) =>
	[...samples].sort((left, right) => left - right)[
		Math.floor(samples.length / 2)
	]!

const createWorkbase = async () => {
	const root = await mkdtemp(join(tmpdir(), "agency-validate-benchmark-"))
	await Bun.write(
		join(root, "agency.json"),
		JSON.stringify({
			version: 2,
			repositories: {
				agency: { remote: "https://example.com/agency.git" },
			},
		}),
	)

	for (let taskIndex = 0; taskIndex < taskCount; taskIndex += 1) {
		const taskId = `task-${taskIndex}`
		const taskPath = join(root, "tasks", taskId)
		const phases = Array.from({ length: phaseCount }, (_, index) => ({
			id: `phase-${index}`,
		}))
		await mkdir(taskPath, { recursive: true })
		await Bun.write(
			join(taskPath, "TASK.md"),
			`---\nticketUrl: null\nphases: ${JSON.stringify(phases)}\n---\n`,
		)
		await Promise.all(
			phases.map(async ({ id }) => {
				const phasePath = join(taskPath, "phases", id)
				await mkdir(phasePath, { recursive: true })
				await Bun.write(
					join(phasePath, "PHASE.md"),
					`---\nrepo: agency\nbranch: ${taskId}/${id}\nbase: main\npr: null\n---\n`,
				)
			}),
		)
	}
	return root
}

const validate = async (root: string) => {
	await Effect.runPromise(
		WorkbaseService.pipe(
			Effect.flatMap((service) => service.validate(root)),
			Effect.provide(WorkbaseService.Default),
			Effect.provide(FileSystemService.Default),
		) as Effect.Effect<unknown, unknown, never>,
	)
}

const root = await createWorkbase()
try {
	const coldStart = performance.now()
	await validate(root)
	const coldMs = performance.now() - coldStart
	const warmSamples: number[] = []
	for (let index = 0; index < sampleCount; index += 1) {
		const start = performance.now()
		await validate(root)
		warmSamples.push(performance.now() - start)
	}
	console.log(
		JSON.stringify(
			{
				taskCount,
				phaseCount,
				documentCount: taskCount * (phaseCount + 1),
				coldMs: Math.round(coldMs),
				warmMedianMs: Math.round(median(warmSamples)),
				warmSamplesMs: warmSamples.map(Math.round),
			},
			null,
			2,
		),
	)
} finally {
	await rm(root, { recursive: true, force: true })
}
