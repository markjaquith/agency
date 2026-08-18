import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const sampleCount = 7
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const cliPath = join(projectRoot, "cli.ts")

const run = async (args: readonly string[], cwd: string) => {
	const start = performance.now()
	const child = Bun.spawn([process.execPath, cliPath, ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	})
	const stdout = await new Response(child.stdout).text()
	const stderr = await new Response(child.stderr).text()
	await child.exited
	if (child.exitCode !== 0) throw new Error(stderr.trim() || stdout.trim())
	return { elapsedMs: performance.now() - start, stdout }
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

const createWorkbase = async (taskCount: number) => {
	const root = await mkdtemp(join(tmpdir(), "agency-claim-benchmark-"))
	await Bun.write(join(root, "agency.json"), '{"version":2}\n')
	for (let index = 0; index < taskCount; index += 1) {
		const id = index === 0 ? "target" : `unrelated-${index}`
		const taskRoot = join(root, "tasks", id)
		await mkdir(taskRoot, { recursive: true })
		await Bun.write(join(taskRoot, "TASK.md"), taskDocument(id))
	}
	return root
}

const median = (samples: readonly number[]) =>
	[...samples].sort((left, right) => left - right)[
		Math.floor(samples.length / 2)
	]!

const measure = async (taskCount: number) => {
	const root = await createWorkbase(taskCount)
	const targetPath = join(root, "tasks/target/TASK.md")
	const originalContent = await readFile(targetPath, "utf8")
	const context = await run(["context", "target", "--json"], root)
	const revision = JSON.parse(context.stdout).result.documents.task.sha256
	const samples: number[] = []
	try {
		for (let index = 0; index < sampleCount; index += 1) {
			const claim = await run(
				[
					"claim",
					"target",
					"--claimant",
					"benchmark",
					"--agent",
					"benchmark",
					"--session-id",
					`sample-${index}`,
					"--revision",
					revision,
					"--silent",
				],
				root,
			)
			samples.push(claim.elapsedMs)
			await writeFile(targetPath, originalContent)
		}
	} finally {
		await rm(root, { recursive: true, force: true })
	}
	return {
		taskCount,
		medianMs: Math.round(median(samples)),
		samplesMs: samples.map(Math.round),
	}
}

console.log(
	JSON.stringify(
		{
			sampleCount,
			small: await measure(1),
			large: await measure(500),
		},
		null,
		2,
	),
)
