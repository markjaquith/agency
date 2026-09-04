import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

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

const createWorkbase = async (taskCount: number, archivedTaskCount: number) => {
	const root = await mkdtemp(join(tmpdir(), "agency-context-benchmark-"))
	const repository = join(root, "repos", "agency")
	await mkdir(repository, { recursive: true })
	await run(["git", "init", "--bare", "--initial-branch=main"], repository)
	await Bun.write(join(root, "agency.json"), '{"version":2}\n')
	const writeTasks = async (count: number, archived: boolean) => {
		for (let index = 1; index <= count; index += 1) {
			const id = `${archived ? "archived" : "benchmark"}-${index}`
			const taskPath = join(root, archived ? "archive/tasks" : "tasks", id)
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
	}
	await writeTasks(taskCount, false)
	await writeTasks(archivedTaskCount, true)
	return root
}

const context = (root: string) =>
	run([process.execPath, cliPath, "context", "benchmark-1", "--silent"], root)

const median = (samples: readonly number[]) =>
	[...samples].sort((left, right) => left - right)[
		Math.floor(samples.length / 2)
	]!

const measure = async (taskCount: number, archivedTaskCount = 0) => {
	const root = await createWorkbase(taskCount, archivedTaskCount)
	try {
		await context(root)
		const samples: number[] = []
		for (let index = 0; index < sampleCount; index += 1) {
			const start = performance.now()
			await context(root)
			samples.push(performance.now() - start)
		}
		return {
			taskCount,
			archivedTaskCount,
			medianMs: Math.round(median(samples)),
			samplesMs: samples.map(Math.round),
		}
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}

console.log(
	JSON.stringify(
		{
			sampleCount,
			small: await measure(5),
			large: await measure(100),
			archiveHeavy: await measure(5, 100),
		},
		null,
		2,
	),
)
