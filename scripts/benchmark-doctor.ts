import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const sampleCount = 5
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const cliPath = join(projectRoot, "cli.ts")
const sizes = [
	{ name: "small", taskCount: 4 },
	{ name: "large", taskCount: 100 },
] as const

const run = async (args: readonly string[], cwd: string) => {
	const child = Bun.spawn([...args], { cwd, stdout: "pipe", stderr: "pipe" })
	const [exitCode, stderr] = await Promise.all([
		child.exited,
		new Response(child.stderr).text(),
	])
	if (exitCode !== 0) throw new Error(stderr.trim() || args.join(" "))
}

const createWorkbase = async (taskCount: number) => {
	const root = await mkdtemp(join(tmpdir(), "agency-doctor-benchmark-"))
	const repository = join(root, "source")
	await mkdir(repository)
	await run(["git", "init", "--initial-branch=main"], repository)
	await run(
		["git", "config", "user.email", "benchmark@example.com"],
		repository,
	)
	await run(["git", "config", "user.name", "Benchmark"], repository)
	await Bun.write(join(repository, "README.md"), "benchmark\n")
	await run(["git", "add", "README.md"], repository)
	await run(
		["git", "-c", "commit.gpgsign=false", "commit", "-m", "initial"],
		repository,
	)
	await run(
		["git", "remote", "add", "origin", "https://example.com/agency.git"],
		repository,
	)
	await mkdir(join(root, "repos"))
	await symlink(repository, join(root, "repos", "agency"))
	await Bun.write(join(root, "agency.json"), JSON.stringify({ version: 2 }))

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

const doctor = (root: string) =>
	run([process.execPath, cliPath, "doctor", "--silent"], root)

const median = (samples: readonly number[]) =>
	[...samples].sort((left, right) => left - right)[
		Math.floor(samples.length / 2)
	]!

const measure = async (root: string) => {
	const coldStart = performance.now()
	await doctor(root)
	const coldMs = performance.now() - coldStart
	const warmSamples: number[] = []
	for (let index = 0; index < sampleCount; index += 1) {
		const start = performance.now()
		await doctor(root)
		warmSamples.push(performance.now() - start)
	}
	return {
		coldMs: Math.round(coldMs),
		warmMedianMs: Math.round(median(warmSamples)),
		warmSamplesMs: warmSamples.map(Math.round),
	}
}

const results: Record<string, unknown> = {}
for (const size of sizes) {
	const root = await createWorkbase(size.taskCount)
	try {
		results[size.name] = { taskCount: size.taskCount, ...(await measure(root)) }
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}

console.log(JSON.stringify({ sampleCount, results }, null, 2))
