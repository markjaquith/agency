import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const sampleCount = 5
const largeTaskCount = 500
const cliPath = join(import.meta.dir, "..", "cli.ts")

const run = async (root: string, subcommand: "status" | "sync") => {
	const child = Bun.spawn(
		[process.execPath, cliPath, "integration", subcommand, "--json"],
		{ cwd: root, stdout: "pipe", stderr: "pipe" },
	)
	await child.exited
	if (child.exitCode !== 0) {
		throw new Error((await new Response(child.stderr).text()).trim())
	}
	await new Response(child.stdout).text()
}

const createWorkbase = async (taskCount: number) => {
	const root = await mkdtemp(join(tmpdir(), "agency-integration-benchmark-"))
	await Bun.write(join(root, "agency.json"), '{"version":2}\n')
	for (let index = 0; index < taskCount; index += 1) {
		const directory = join(root, "tasks", `benchmark-${index}`)
		await mkdir(directory, { recursive: true })
		await Bun.write(join(directory, "TASK.md"), "---\nstatus: open\n---\n")
	}
	return root
}

const median = (samples: readonly number[]) =>
	[...samples].sort((left, right) => left - right)[
		Math.floor(samples.length / 2)
	]!

const measure = async (
	root: string,
	subcommand: "status" | "sync",
	samplesToTake = sampleCount,
) => {
	const samples: number[] = []
	for (let index = 0; index < samplesToTake; index += 1) {
		const start = performance.now()
		await run(root, subcommand)
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
		const coldSync = await measure(root, "sync", 1)
		const warmStatus = await measure(root, "status")
		const warmSync = await measure(root, "sync")
		return { taskCount, coldSync, warmStatus, warmSync }
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}

console.log(
	JSON.stringify(
		{
			sampleCount,
			small: await benchmark(0),
			large: await benchmark(largeTaskCount),
		},
		null,
		2,
	),
)
