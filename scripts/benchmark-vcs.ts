import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const sampleCount = 5
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const cliPath = join(projectRoot, "cli.ts")

const run = async (args: readonly string[], cwd: string) => {
	const child = Bun.spawn([...args], { cwd, stdout: "pipe", stderr: "pipe" })
	const exitCode = await child.exited
	if (exitCode !== 0) throw new Error(await new Response(child.stderr).text())
}

const createWorkbase = async (repositoryCount: number) => {
	const root = await mkdtemp(join(tmpdir(), "agency-vcs-benchmark-"))
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
	for (let index = 1; index <= repositoryCount; index += 1) {
		const repository = join(root, "repos", `repo-${index}`)
		await run(["git", "init", "--bare", repository], root)
		await run(
			["git", "-C", repository, "remote", "add", "origin", source],
			root,
		)
	}
	await Bun.write(
		join(root, "agency.json"),
		JSON.stringify({ version: 2, vcs: "git" }),
	)
	return root
}

const median = (samples: readonly number[]) =>
	[...samples].sort((left, right) => left - right)[
		Math.floor(samples.length / 2)
	]!

const measure = async (repositoryCount: number) => {
	const root = await createWorkbase(repositoryCount)
	try {
		const samples: number[] = []
		for (let index = 0; index < sampleCount; index += 1) {
			const start = performance.now()
			await run([process.execPath, cliPath, "vcs", "status", "--json"], root)
			samples.push(performance.now() - start)
		}
		return {
			repositoryCount,
			medianMs: Math.round(median(samples)),
			samplesMs: samples.map(Math.round),
		}
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}

console.log(
	JSON.stringify(
		{ sampleCount, small: await measure(2), large: await measure(12) },
		null,
		2,
	),
)
