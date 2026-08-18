import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const sampleCount = 7
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const cliPath = join(projectRoot, "cli.ts")

const run = async (root: string) => {
	const started = performance.now()
	const child = Bun.spawn(
		[process.execPath, cliPath, "act", "--json", "--silent"],
		{ cwd: root, stdout: "pipe", stderr: "pipe" },
	)
	await child.exited
	if (child.exitCode !== 0) {
		throw new Error((await new Response(child.stderr).text()).trim())
	}
	return performance.now() - started
}

const createWorkbase = async (taskCount: number) => {
	const root = await mkdtemp(join(tmpdir(), "agency-act-benchmark-"))
	await Bun.write(join(root, "agency.json"), '{"version":2}\n')
	await mkdir(join(root, "repos/agency"), { recursive: true })
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

const measure = async (taskCount: number) => {
	const root = await createWorkbase(taskCount)
	try {
		const coldMs = await run(root)
		const warmSamples: number[] = []
		for (let index = 0; index < sampleCount; index += 1) {
			warmSamples.push(await run(root))
		}
		return {
			taskCount,
			coldMs: Math.round(coldMs),
			warmMedianMs: Math.round(median(warmSamples)),
			warmSamplesMs: warmSamples.map(Math.round),
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
			large: await measure(250),
		},
		null,
		2,
	),
)
