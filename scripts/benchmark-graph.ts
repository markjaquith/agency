import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const sampleCount = 3
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const cliPath = join(projectRoot, "cli.ts")

const median = (samples: readonly number[]) =>
	[...samples].sort((left, right) => left - right)[
		Math.floor(samples.length / 2)
	]!

const createWorkbase = async (taskCount: number, phaseCount: number) => {
	const root = await mkdtemp(join(tmpdir(), "agency-graph-benchmark-"))
	await mkdir(join(root, "repos/agency"), { recursive: true })
	await Bun.write(join(root, "agency.json"), '{"version":2}\n')
	for (let taskIndex = 1; taskIndex <= taskCount; taskIndex += 1) {
		const taskId = `task-${taskIndex}`
		const taskPath = join(root, "tasks", taskId)
		await mkdir(taskPath, { recursive: true })
		if (phaseCount === 0) {
			await Bun.write(
				join(taskPath, "TASK.md"),
				`---
ticketUrl: null
repo: agency
branch: task/${taskId}
base: main
pr: null
status: open
---

# ${taskId}
`,
			)
			continue
		}
		const phases = Array.from({ length: phaseCount }, (_, index) => ({
			id: `phase-${index + 1}`,
			dependsOn: index === 0 ? [] : [`phase-${index}`],
		}))
		await Bun.write(
			join(taskPath, "TASK.md"),
			`---
ticketUrl: null
phases:
${phases
	.map(
		(phase) =>
			`  - id: ${phase.id}${phase.dependsOn.length ? `\n    dependsOn: [${phase.dependsOn.join(", ")}]` : ""}`,
	)
	.join("\n")}
---

# ${taskId}
`,
		)
		for (const phase of phases) {
			const phasePath = join(taskPath, "phases", phase.id)
			await mkdir(phasePath, { recursive: true })
			await Bun.write(
				join(phasePath, "PHASE.md"),
				`---
repo: agency
branch: task/${taskId}/${phase.id}
base: main
pr: null
status: open
---

# ${phase.id}
`,
			)
		}
	}
	return root
}

const graph = async (root: string, args: readonly string[] = []) => {
	const child = Bun.spawn(
		[process.execPath, cliPath, "graph", "--json", "--silent", ...args],
		{ cwd: root, stdout: "ignore", stderr: "pipe" },
	)
	await child.exited
	if (child.exitCode !== 0) {
		throw new Error((await new Response(child.stderr).text()).trim())
	}
}

const measure = async (root: string, args: readonly string[] = []) => {
	await graph(root, args)
	const samples: number[] = []
	for (let index = 0; index < sampleCount; index += 1) {
		const start = performance.now()
		await graph(root, args)
		samples.push(performance.now() - start)
	}
	return {
		medianMs: Math.round(median(samples)),
		samplesMs: samples.map(Math.round),
	}
}

const cases = [
	{ name: "small", taskCount: 20, phaseCount: 0 },
	{ name: "large-single-phase", taskCount: 200, phaseCount: 0 },
	{ name: "large-multi-phase", taskCount: 50, phaseCount: 10 },
] as const
const results: Record<string, unknown> = {}
for (const benchmark of cases) {
	const root = await createWorkbase(benchmark.taskCount, benchmark.phaseCount)
	try {
		results[benchmark.name] = {
			taskCount: benchmark.taskCount,
			phaseCount: benchmark.phaseCount,
			documentCount: benchmark.taskCount * (benchmark.phaseCount + 1),
			baseline: await measure(root),
			filtered: await measure(root, ["--kind", "execution-unit", "--ready"]),
		}
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}

console.log(JSON.stringify({ sampleCount, results }, null, 2))
