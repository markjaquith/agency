import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const taskCount = Number(process.env.AGENCY_BENCHMARK_TASKS ?? 200)
const phaseCount = Number(process.env.AGENCY_BENCHMARK_PHASES ?? 5)
const sampleCount = Number(process.env.AGENCY_BENCHMARK_SAMPLES ?? 5)
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

const taskDocument = (id: string) => `---
ticketUrl: null
repo: agency
branch: task/${id}
base: main
pr: null
status: open
---

# ${id}
`

const phaseDocument = (taskId: string, phaseId: string) => `---
repo: agency
branch: task/${taskId}-${phaseId}
base: main
pr: null
status: open
---

# ${phaseId}
`

const createWorkbase = async () => {
	const root = await mkdtemp(join(tmpdir(), "agency-worktree-benchmark-"))
	await mkdir(join(root, "repos"))
	await Bun.write(join(root, "agency.json"), JSON.stringify({ version: 2 }))
	for (let taskIndex = 0; taskIndex < taskCount; taskIndex += 1) {
		const id = `single-${taskIndex.toString().padStart(4, "0")}`
		const taskPath = join(root, "tasks", id)
		await mkdir(taskPath, { recursive: true })
		await Bun.write(join(taskPath, "TASK.md"), taskDocument(id))
	}
	const multiPath = join(root, "tasks", "multi")
	await mkdir(multiPath, { recursive: true })
	await Bun.write(
		join(multiPath, "TASK.md"),
		`---
ticketUrl: null
phases:
${Array.from({ length: phaseCount }, (_, index) => `  - id: phase-${index.toString().padStart(2, "0")}`).join("\n")}
---

# multi
`,
	)
	for (let phaseIndex = 0; phaseIndex < phaseCount; phaseIndex += 1) {
		const id = `phase-${phaseIndex.toString().padStart(2, "0")}`
		const phasePath = join(multiPath, "phases", id)
		await mkdir(phasePath, { recursive: true })
		await Bun.write(join(phasePath, "PHASE.md"), phaseDocument("multi", id))
	}
	return root
}

const median = (samples: readonly number[]) =>
	[...samples].sort((left, right) => left - right)[
		Math.floor(samples.length / 2)
	]!

const measure = async (root: string, args: readonly string[]) => {
	await run([process.execPath, cliPath, ...args, "--silent"], root)
	const samples: number[] = []
	for (let index = 0; index < sampleCount; index += 1) {
		const start = performance.now()
		await run([process.execPath, cliPath, ...args, "--silent"], root)
		samples.push(performance.now() - start)
	}
	return {
		medianMs: Math.round(median(samples)),
		samplesMs: samples.map(Math.round),
	}
}

const root = await createWorkbase()
try {
	const inspect = await measure(root, ["worktree", "inspect", "single-0000"])
	const list = await measure(root, ["worktree", "list"])
	console.log(
		JSON.stringify(
			{ taskCount, phaseCount, sampleCount, inspect, list },
			null,
			2,
		),
	)
} finally {
	await rm(root, { recursive: true, force: true })
}
