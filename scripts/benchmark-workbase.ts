import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const sampleCount = 7
const sizes = [10, 250] as const
const cliPath = join(import.meta.dir, "../cli.ts")

const median = (samples: readonly number[]) =>
	[...samples].sort((left, right) => left - right)[
		Math.floor(samples.length / 2)
	]!

const run = async (root: string, command: string) => {
	const start = performance.now()
	const child = Bun.spawn(
		[process.execPath, cliPath, command, "--json", "--silent"],
		{ cwd: root, stdout: "ignore", stderr: "pipe" },
	)
	await child.exited
	if (child.exitCode !== 0) {
		throw new Error((await new Response(child.stderr).text()).trim())
	}
	return performance.now() - start
}

const createWorkbase = async (taskCount: number) => {
	const root = await mkdtemp(join(tmpdir(), "agency-workbase-benchmark-"))
	await Promise.all([
		mkdir(join(root, "repos/agency"), { recursive: true }),
		Bun.write(join(root, "agency.json"), '{"version":2}\n'),
		...Array.from({ length: taskCount }, (_, index) => {
			const id = `task-${String(index + 1).padStart(4, "0")}`
			const path = join(root, "tasks", id, "TASK.md")
			return mkdir(join(root, "tasks", id), { recursive: true }).then(() =>
				Bun.write(
					path,
					`---\nticketUrl: null\nrepo: agency\nbranch: task/${id}\nbase: main\npr: null\nstatus: open\n---\n\n# ${id}\n`,
				),
			)
		}),
	])
	return root
}

const measure = async (root: string, command: string) => {
	const coldMs = await run(root, command)
	const samples: number[] = []
	for (let index = 0; index < sampleCount; index += 1) {
		samples.push(await run(root, command))
	}
	return {
		coldMs: Math.round(coldMs),
		warmMedianMs: Math.round(median(samples)),
		warmSamplesMs: samples.map(Math.round),
	}
}

const results = []
for (const taskCount of sizes) {
	const root = await createWorkbase(taskCount)
	try {
		results.push({
			taskCount,
			validate: await measure(root, "validate"),
			graph: await measure(root, "graph"),
		})
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}

console.log(JSON.stringify({ sampleCount, results }, null, 2))
