import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const repositoryCount = 40
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
	const root = await mkdtemp(join(tmpdir(), "agency-repository-benchmark-"))
	const repositories: Record<string, { remote: string }> = {}
	await mkdir(join(root, "repos"))
	for (let index = 1; index <= repositoryCount; index += 1) {
		const alias = `repository-${index.toString().padStart(2, "0")}`
		const path = join(root, "repos", alias)
		const remote = `https://example.com/${alias}.git`
		await run(["git", "init", "--bare", path], root)
		await run(["git", "-C", path, "remote", "add", "origin", remote], root)
		repositories[alias] = { remote }
	}
	await Bun.write(
		join(root, "agency.json"),
		JSON.stringify({ version: 2, repositories }),
	)
	return root
}

const median = (samples: readonly number[]) =>
	[...samples].sort((left, right) => left - right)[
		Math.floor(samples.length / 2)
	]!

const root = await createWorkbase()
try {
	const command = [process.execPath, cliPath, "repo", "list", "--json"]
	await run(command, root)
	const samples: number[] = []
	for (let index = 0; index < sampleCount; index += 1) {
		const start = performance.now()
		await run(command, root)
		samples.push(performance.now() - start)
	}
	console.log(
		JSON.stringify(
			{
				repositoryCount,
				sampleCount,
				medianMs: Math.round(median(samples)),
				samplesMs: samples.map(Math.round),
			},
			null,
			2,
		),
	)
} finally {
	await rm(root, { recursive: true, force: true })
}
