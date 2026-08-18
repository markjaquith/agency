import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const sampleCount = 3
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const cliPath = join(projectRoot, "cli.ts")

const run = async (args: readonly string[], cwd: string) => {
	const child = Bun.spawn([...args], { cwd, stdout: "pipe", stderr: "pipe" })
	const [stderr, exitCode] = await Promise.all([
		new Response(child.stderr).text(),
		child.exited,
	])
	if (exitCode !== 0) throw new Error(stderr.trim() || args.join(" "))
}

const createWorkbase = async (vcs: "git" | "jj") => {
	const root = await mkdtemp(join(tmpdir(), `agency-push-${vcs}-`))
	const remote = join(root, "remote.git")
	const seed = join(root, "seed")
	const repository = join(root, "repos", "agency")
	await mkdir(join(root, "repos"), { recursive: true })
	await Bun.write(
		join(root, "agency.json"),
		`${JSON.stringify({ version: 2, vcs }, null, 2)}\n`,
	)
	await run(["git", "init", "--bare", "--initial-branch=main", remote], root)
	await run(["git", "init", "--initial-branch=main", seed], root)
	await run(["git", "config", "user.name", "Benchmark"], seed)
	await run(["git", "config", "user.email", "benchmark@example.com"], seed)
	await Bun.write(join(seed, "README.md"), "benchmark\n")
	await run(["git", "add", "README.md"], seed)
	await run(
		["git", "-c", "commit.gpgsign=false", "commit", "-m", "Initial"],
		seed,
	)
	await run(["git", "remote", "add", "origin", remote], seed)
	await run(["git", "push", "origin", "main"], seed)
	if (vcs === "jj")
		await run(["jj", "git", "clone", "--no-colocate", remote, repository], root)
	else await run(["git", "clone", "--bare", remote, repository], root)
	await run(
		[
			process.execPath,
			cliPath,
			"task",
			"create",
			"benchmark",
			"--repo",
			"agency",
			"--branch",
			"task/benchmark",
			"--base",
			"main",
			"--json",
		],
		root,
	)
	await run(
		[
			process.execPath,
			cliPath,
			"task",
			"status",
			"benchmark",
			"working",
			"--json",
		],
		root,
	)
	await run(
		[process.execPath, cliPath, "worktree", "prepare", "benchmark", "--json"],
		root,
	)
	const task = join(root, "tasks", "benchmark")
	const checkout = join(task, "code", "agency")
	await run(
		vcs === "jj"
			? ["jj", "describe", "-m", "Benchmark"]
			: ["git", "commit", "--allow-empty", "-m", "Benchmark"],
		checkout,
	)
	return { root, task }
}

const median = (samples: readonly number[]) =>
	[...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]!

for (const vcs of ["git", "jj"] as const) {
	if (vcs === "jj" && !Bun.which("jj")) continue
	const samples: number[] = []
	for (let index = 0; index < sampleCount; index += 1) {
		const fixture = await createWorkbase(vcs)
		try {
			const start = performance.now()
			await run([process.execPath, cliPath, "push", "--silent"], fixture.task)
			samples.push(performance.now() - start)
		} finally {
			await rm(fixture.root, { recursive: true, force: true })
		}
	}
	console.log(
		JSON.stringify({
			vcs,
			sampleCount,
			medianMs: Math.round(median(samples)),
			samplesMs: samples.map(Math.round),
		}),
	)
}
