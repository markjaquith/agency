import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const taskCounts = [10, 100]
const sampleCount = 5
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const cliPath = join(projectRoot, "cli.ts")

const run = async (args: readonly string[], cwd: string) => {
	const child = Bun.spawn([...args], { cwd, stdout: "pipe", stderr: "pipe" })
	const [exitCode, stderr] = await Promise.all([
		child.exited,
		new Response(child.stderr).text(),
	])
	if (exitCode !== 0) throw new Error(stderr.trim() || args.join(" "))
}

const createWorkbase = async (taskCount: number) => {
	const root = await mkdtemp(join(tmpdir(), "agency-archive-benchmark-"))
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
status: dropped
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

const results = []
for (const taskCount of taskCounts) {
	const root = await createWorkbase(taskCount)
	try {
		const command = [
			process.execPath,
			cliPath,
			"archive",
			"tasks",
			"--dry-run",
			"--silent",
		]
		await run(command, root)
		const samples: number[] = []
		for (let index = 0; index < sampleCount; index += 1) {
			const start = performance.now()
			await run(command, root)
			samples.push(performance.now() - start)
		}
		results.push({
			taskCount,
			medianMs: Math.round(median(samples)),
			samplesMs: samples.map(Math.round),
		})
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}

console.log(JSON.stringify({ sampleCount, results }, null, 2))
