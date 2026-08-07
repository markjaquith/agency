import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const executionCount = 12
const sampleCount = 5
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

const createWorkbase = async () => {
	const root = await mkdtemp(join(tmpdir(), "agency-sync-benchmark-"))
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
	await Bun.write(
		join(root, "agency.json"),
		JSON.stringify({
			version: 2,
			delivery: {
				provider: "benchmark",
				createCommand: ["false"],
				queryCommand: ["sh", "-c", "sleep 0.1; printf null", "{branch}"],
			},
		}),
	)
	for (let index = 1; index <= executionCount; index += 1) {
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

# ${id}
`,
		)
	}
	return root
}

const sync = (root: string, apply = false) =>
	run(
		[
			process.execPath,
			cliPath,
			"sync",
			...(apply ? [] : ["--dry-run"]),
			"--silent",
		],
		root,
	)

const median = (samples: readonly number[]) =>
	[...samples].sort((left, right) => left - right)[
		Math.floor(samples.length / 2)
	]!

const measure = async (root: string) => {
	await sync(root)
	const samples: number[] = []
	for (let index = 0; index < sampleCount; index += 1) {
		const start = performance.now()
		await sync(root)
		samples.push(performance.now() - start)
	}
	return {
		medianMs: Math.round(median(samples)),
		samplesMs: samples.map(Math.round),
	}
}

const root = await createWorkbase()
try {
	const reconciliationRequired = await measure(root)
	await sync(root, true)
	const alreadySynchronized = await measure(root)
	console.log(
		JSON.stringify(
			{
				executionCount,
				sampleCount,
				reconciliationRequired,
				alreadySynchronized,
			},
			null,
			2,
		),
	)
} finally {
	await rm(root, { recursive: true, force: true })
}
