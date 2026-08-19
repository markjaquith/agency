import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const executionCounts = (process.env.AGENCY_SYNC_BENCHMARK_COUNTS ?? "12,120")
	.split(",")
	.map(Number)
const sampleCount = Number(process.env.AGENCY_SYNC_BENCHMARK_SAMPLES ?? 5)
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const cliPath = join(projectRoot, "cli.ts")

const run = async (args: readonly string[], cwd: string) => {
	const child = Bun.spawn([...args], { cwd, stdout: "pipe", stderr: "pipe" })
	await child.exited
	if (child.exitCode !== 0) {
		throw new Error(
			(await new Response(child.stderr).text()).trim() ||
				`Command failed: ${args.join(" ")}`,
		)
	}
}

const createWorkbase = async (executionCount: number) => {
	const root = await mkdtemp(join(tmpdir(), "agency-sync-benchmark-"))
	const source = join(root, "source")
	await mkdir(source)
	await run(["git", "init", "--initial-branch=main"], source)
	await run(["git", "config", "user.email", "benchmark@example.com"], source)
	await run(["git", "config", "user.name", "Benchmark"], source)
	await Bun.write(join(source, "README.md"), "benchmark\n")
	await run(["git", "add", "README.md"], source)
	await run(
		["git", "-c", "commit.gpgsign=false", "commit", "-m", "initial"],
		source,
	)
	await mkdir(join(root, "repos"))
	await run(
		["git", "clone", "--bare", source, join(root, "repos/agency")],
		root,
	)
	await Bun.write(join(root, "agency.json"), '{"version":2}\n')
	for (let index = 1; index <= executionCount; index += 1) {
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
status: done
completion:
  mode: non-pr
  summary: Benchmark fixture
  completedAt: 2026-01-01T00:00:00.000Z
---

# ${id}
`,
		)
	}
	return root
}

const sync = (root: string) =>
	run([process.execPath, cliPath, "sync", "--dry-run", "--silent"], root)

const median = (samples: readonly number[]) =>
	[...samples].sort((left, right) => left - right)[
		Math.floor(samples.length / 2)
	]!

const measure = async (root: string) => {
	const coldStart = performance.now()
	await sync(root)
	const coldMs = performance.now() - coldStart
	const warmSamples: number[] = []
	for (let index = 0; index < sampleCount; index += 1) {
		const start = performance.now()
		await sync(root)
		warmSamples.push(performance.now() - start)
	}
	return {
		coldMs: Math.round(coldMs),
		warmMedianMs: Math.round(median(warmSamples)),
		warmSamplesMs: warmSamples.map(Math.round),
	}
}

const scenarios = []
for (const executionCount of executionCounts) {
	const root = await createWorkbase(executionCount)
	try {
		scenarios.push({ executionCount, ...(await measure(root)) })
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}

console.log(JSON.stringify({ sampleCount, scenarios }, null, 2))
