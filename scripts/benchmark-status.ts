import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const sampleCount = 3
const taskCounts = [10, 100]
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

const createWorkbase = async (taskCount: number) => {
	const root = await mkdtemp(join(tmpdir(), "agency-status-benchmark-"))
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
`,
		)
	}
	return root
}

const median = (samples: readonly number[]) =>
	[...samples].sort((left, right) => left - right)[
		Math.floor(samples.length / 2)
	]!

const measure = async (root: string, json: boolean) => {
	const args = [
		process.execPath,
		cliPath,
		"status",
		...(json ? ["--json"] : ["--silent"]),
	]
	await run(args, root)
	const samples: number[] = []
	for (let index = 0; index < sampleCount; index += 1) {
		const start = performance.now()
		await run(args, root)
		samples.push(performance.now() - start)
	}
	return {
		medianMs: Math.round(median(samples)),
		samplesMs: samples.map(Math.round),
	}
}

const results = []
for (const taskCount of taskCounts) {
	const root = await createWorkbase(taskCount)
	try {
		results.push({
			taskCount,
			human: await measure(root, false),
			json: await measure(root, true),
		})
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}

console.log(JSON.stringify({ sampleCount, results }, null, 2))
