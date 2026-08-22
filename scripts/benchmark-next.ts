import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect, Layer } from "effect"
import { FileSystemService } from "../src/services/FileSystemService"
import { GraphService } from "../src/services/GraphService"
import {
	GitVersionControlService,
	VersionControlService,
} from "../src/services/VersionControlService"
import { WorkbaseService } from "../src/services/WorkbaseService"

const sampleCount = 7
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const cliPath = join(projectRoot, "cli.ts")
const benchmarkLayer = Layer.mergeAll(
	FileSystemService.Default,
	WorkbaseService.Default,
	GitVersionControlService.Default,
	VersionControlService.Default,
	GraphService.Default,
)

const run = async (root: string) => {
	const child = Bun.spawn(
		[process.execPath, cliPath, "next", "--json", "--silent"],
		{ cwd: root, stdout: "ignore", stderr: "pipe" },
	)
	await child.exited
	if (child.exitCode !== 0) {
		throw new Error((await new Response(child.stderr).text()).trim())
	}
}

const runInProcess = (root: string) => {
	const effect = GraphService.pipe(
		Effect.flatMap((service) => service.get({ cwd: root })),
		Effect.provide(benchmarkLayer),
	) as Effect.Effect<unknown, unknown, never>
	return Effect.runPromise(effect)
}

const createWorkbase = async (executionCount: number) => {
	const root = await mkdtemp(join(tmpdir(), "agency-next-benchmark-"))
	await Bun.write(join(root, "agency.json"), '{"version":2}\n')
	await mkdir(join(root, "repos", "agency"), { recursive: true })
	for (let index = 0; index < executionCount; index += 1) {
		const id = `task-${String(index).padStart(4, "0")}`
		const path = join(root, "tasks", id)
		await mkdir(path, { recursive: true })
		await Bun.write(
			join(path, "TASK.md"),
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

const measure = async (executionCount: number) => {
	const root = await createWorkbase(executionCount)
	try {
		const inProcessSamples: number[] = []
		for (let index = 0; index < sampleCount; index += 1) {
			const start = performance.now()
			await runInProcess(root)
			inProcessSamples.push(performance.now() - start)
		}
		const coldStart = performance.now()
		await run(root)
		const coldMs = performance.now() - coldStart
		const samples: number[] = []
		for (let index = 0; index < sampleCount; index += 1) {
			const start = performance.now()
			await run(root)
			samples.push(performance.now() - start)
		}
		return {
			executionCount,
			inProcessMedianMs: Math.round(median(inProcessSamples)),
			inProcessSamplesMs: inProcessSamples.map(Math.round),
			coldMs: Math.round(coldMs),
			warmMedianMs: Math.round(median(samples)),
			warmSamplesMs: samples.map(Math.round),
		}
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}

console.log(
	JSON.stringify(
		{
			sampleCount,
			small: await measure(12),
			large: await measure(500),
		},
		null,
		2,
	),
)
