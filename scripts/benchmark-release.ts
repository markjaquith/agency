import { Effect, Layer } from "effect"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ClaimService } from "../src/services/ClaimService"
import { FileSystemService } from "../src/services/FileSystemService"
import { PhaseService } from "../src/services/PhaseService"
import { TaskService } from "../src/services/TaskService"
import { WorkbaseService } from "../src/services/WorkbaseService"

const sampleCount = 25
const BenchmarkLayer = Layer.mergeAll(
	FileSystemService.Default,
	WorkbaseService.Default,
	TaskService.Default,
	PhaseService.Default,
	ClaimService.Default,
)

const runEffect = <A, E>(effect: Effect.Effect<A, E, any>) =>
	Effect.runPromise(
		effect.pipe(Effect.provide(BenchmarkLayer)) as Effect.Effect<A, E>,
	)

const createWorkbase = async (taskCount: number) => {
	const root = await mkdtemp(join(tmpdir(), "agency-release-benchmark-"))
	await mkdir(join(root, "repos", "agency"), { recursive: true })
	await Bun.write(join(root, "agency.json"), '{"version":2}\n')
	for (let index = 1; index <= taskCount; index += 1) {
		const id = `benchmark-${index}`
		const taskPath = join(root, "tasks", id)
		await mkdir(taskPath, { recursive: true })
		await Bun.write(
			join(taskPath, "TASK.md"),
			`---
ticketUrl: null
repo: agency
branch: task/${id}
base: main
pr: null
status: open
---

# ${id}
`,
		)
	}
	return root
}

const median = (samples: readonly number[]) =>
	[...samples].sort((left, right) => left - right)[
		Math.floor(samples.length / 2)
	]!

const measure = async (operation: () => Promise<unknown>) => {
	const samples: number[] = []
	for (let index = 0; index < sampleCount; index += 1) {
		const start = performance.now()
		await operation()
		samples.push(performance.now() - start)
	}
	return {
		medianMs: Number(median(samples).toFixed(2)),
		minimumMs: Number(Math.min(...samples).toFixed(2)),
	}
}

const benchmark = async (taskCount: number) => {
	const root = await createWorkbase(taskCount)
	const taskId = `benchmark-${taskCount}`
	try {
		const inspect = () =>
			runEffect(
				ClaimService.pipe(
					Effect.flatMap((service) => service.inspect(taskId, undefined, root)),
				),
			)
		await inspect()
		return {
			taskCount,
			targetInspection: await measure(inspect),
			validation: await measure(() =>
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

console.log(
	JSON.stringify(
		{
			sampleCount,
			small: await benchmark(4),
			large: await benchmark(500),
		},
		null,
		2,
	),
)
