import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const taskCounts = [1, 250]
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

const createWorkbase = async (taskCount: number) => {
	const root = await mkdtemp(join(tmpdir(), "agency-review-benchmark-"))
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
	await Bun.write(join(root, "agency.json"), '{"version":2}\n')
	await run(
		[
			process.execPath,
			cliPath,
			"task",
			"create",
			"review",
			"--review",
			"agency",
			"--ref",
			"main",
			"--silent",
		],
		root,
	)
	for (let index = 1; index < taskCount; index += 1) {
		const id = `unrelated-${index}`
		const taskPath = join(root, "tasks", id)
		await mkdir(taskPath, { recursive: true })
		await Bun.write(
			join(taskPath, "TASK.md"),
			`---\nticketUrl: null\nrepo: agency\nbranch: task/${id}\nbase: main\npr: null\nstatus: open\n---\n\n# ${id}\n`,
		)
	}
	return root
}

const median = (samples: readonly number[]) =>
	[...samples].sort((left, right) => left - right)[
		Math.floor(samples.length / 2)
	]!

const results = []
for (const taskCount of taskCounts) {
	const root = await createWorkbase(taskCount)
	try {
		const samples: number[] = []
		for (let index = 0; index < sampleCount; index += 1) {
			const start = performance.now()
			await run(
				[process.execPath, cliPath, "review", "refresh", "review", "--silent"],
				root,
			)
			samples.push(performance.now() - start)
		}
		results.push({
			taskCount,
			medianMs: Math.round(median(samples)),
			samplesMs: samples.map(Math.round),
		})
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}

console.log(JSON.stringify({ sampleCount, results }, null, 2))
