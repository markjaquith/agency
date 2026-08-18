import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { documentRevision } from "../src/workbase/document-revision"

const sampleCount = 3
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const cliPath = join(projectRoot, "cli.ts")

const taskDocument = (id: string, sessionId?: string) => `---
ticketUrl: null
repo: agency
branch: task/${id}
base: main
pr: null
status: ${sessionId ? "working" : "open"}
${sessionId ? `claim:\n  claimant: benchmark\n  agent: benchmark\n  sessionId: ${sessionId}\n  startedAt: 2026-01-01T00:00:00.000Z\n  targetRevision: "${"0".repeat(64)}"\n  state: active\n` : ""}---

# ${id}
`

const phaseDocument = (id: string, sessionId?: string) => `---
repo: agency
branch: phase/${id}
base: main
pr: null
status: ${sessionId ? "working" : "open"}
${sessionId ? `claim:\n  claimant: benchmark\n  agent: benchmark\n  sessionId: ${sessionId}\n  startedAt: 2026-01-01T00:00:00.000Z\n  targetRevision: "${"0".repeat(64)}"\n  state: active\n` : ""}---

# ${id}
`

const createWorkbase = async (taskCount: number, phaseCount: number) => {
	const root = await mkdtemp(join(tmpdir(), "agency-finish-benchmark-"))
	await Bun.write(join(root, "agency.json"), '{"version":2}\n')
	for (let index = 0; index < taskCount; index += 1) {
		const id = `task-${index}`
		const directory = join(root, "tasks", id)
		await mkdir(directory, { recursive: true })
		await Bun.write(join(directory, "TASK.md"), taskDocument(id))
	}
	if (phaseCount > 0) {
		const directory = join(root, "tasks", "phased")
		await mkdir(join(directory, "phases"), { recursive: true })
		await Bun.write(
			join(directory, "TASK.md"),
			`---\nticketUrl: null\nphases:\n${Array.from({ length: phaseCount }, (_, index) => `  - id: phase-${index}`).join("\n")}\nstatus: working\n---\n\n# phased\n`,
		)
		for (let index = 0; index < phaseCount; index += 1) {
			const phaseDirectory = join(directory, "phases", `phase-${index}`)
			await mkdir(phaseDirectory, { recursive: true })
			await Bun.write(
				join(phaseDirectory, "PHASE.md"),
				phaseDocument(`phase-${index}`),
			)
		}
	}
	return root
}

const finish = async (root: string, taskId: string, phaseId?: string) => {
	const sessionId = `benchmark-${crypto.randomUUID()}`
	const path = phaseId
		? join(root, "tasks", taskId, "phases", phaseId, "PHASE.md")
		: join(root, "tasks", taskId, "TASK.md")
	const content = phaseId
		? phaseDocument(phaseId, sessionId)
		: taskDocument(taskId, sessionId)
	await Bun.write(path, content)
	const child = Bun.spawn(
		[
			process.execPath,
			cliPath,
			"finish",
			taskId,
			...(phaseId ? [phaseId] : []),
			"--session-id",
			sessionId,
			"--revision",
			documentRevision(content),
			"--outcome",
			"dropped",
			"--silent",
		],
		{ cwd: root, stdout: "pipe", stderr: "pipe" },
	)
	await child.exited
	if (child.exitCode !== 0) {
		throw new Error((await new Response(child.stderr).text()).trim())
	}
}

const median = (samples: readonly number[]) =>
	[...samples].sort((left, right) => left - right)[
		Math.floor(samples.length / 2)
	]!

const measure = async (root: string, taskId: string, phaseId?: string) => {
	await finish(root, taskId, phaseId)
	const samples: number[] = []
	for (let index = 0; index < sampleCount; index += 1) {
		const start = performance.now()
		await finish(root, taskId, phaseId)
		samples.push(performance.now() - start)
	}
	return {
		medianMs: Math.round(median(samples)),
		samplesMs: samples.map(Math.round),
	}
}

const configurations = [
	{ name: "smallTask", taskCount: 1, phaseCount: 0, taskId: "task-0" },
	{ name: "largeTask", taskCount: 500, phaseCount: 0, taskId: "task-499" },
	{
		name: "largePhase",
		taskCount: 500,
		phaseCount: 500,
		taskId: "phased",
		phaseId: "phase-499",
	},
] as const

const results: Record<string, unknown> = {}
for (const configuration of configurations) {
	const root = await createWorkbase(
		configuration.taskCount,
		configuration.phaseCount,
	)
	try {
		results[configuration.name] = await measure(
			root,
			configuration.taskId,
			"phaseId" in configuration ? configuration.phaseId : undefined,
		)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}

console.log(JSON.stringify({ sampleCount, results }, null, 2))
