import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const sampleCount = 3
const sizes = { small: 10, large: 250 }
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const cliPath = join(projectRoot, "cli.ts")

const run = async (args: readonly string[], cwd: string) => {
	const child = Bun.spawn([process.execPath, cliPath, ...args, "--silent"], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	})
	const [exitCode, stderr] = await Promise.all([
		child.exited,
		new Response(child.stderr).text(),
	])
	if (exitCode !== 0) throw new Error(stderr.trim() || args.join(" "))
}

const createWorkbase = async (taskCount: number) => {
	const root = await mkdtemp(join(tmpdir(), "agency-task-benchmark-"))
	await mkdir(join(root, "repos", "agency"), { recursive: true })
	await Bun.write(join(root, "agency.json"), '{"version":2}\n')
	for (let index = 1; index <= taskCount; index += 1) {
		const id = `benchmark-${index}`
		const directory = join(root, "tasks", id)
		await mkdir(directory, { recursive: true })
		await Bun.write(
			join(directory, "TASK.md"),
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

const measure = async (
	root: string,
	operation: (sample: number) => Promise<void>,
) => {
	const samples: number[] = []
	for (let sample = 0; sample < sampleCount; sample += 1) {
		const start = performance.now()
		await operation(sample)
		samples.push(performance.now() - start)
	}
	return {
		medianMs: Math.round(median(samples)),
		samplesMs: samples.map(Math.round),
	}
}

const benchmark = async (taskCount: number) => {
	const root = await createWorkbase(taskCount)
	try {
		return {
			create: await measure(root, (sample) =>
				run(["task", "create", `created-${sample}`, "--repo", "agency"], root),
			),
			show: await measure(root, () =>
				run(["task", "show", "benchmark-1"], root),
			),
			list: await measure(root, () => run(["task", "list"], root)),
			status: await measure(root, (sample) =>
				run(["task", "status", `benchmark-${sample + 1}`, "working"], root),
			),
			validate: await measure(root, () => run(["validate"], root)),
		}
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}

const results = Object.fromEntries(
	await Promise.all(
		Object.entries(sizes).map(async ([size, taskCount]) => [
			size,
			{ taskCount, sampleCount, operations: await benchmark(taskCount) },
		]),
	),
)

console.log(JSON.stringify(results, null, 2))
