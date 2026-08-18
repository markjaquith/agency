import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const sampleCount = 3
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const cliPath = join(projectRoot, "cli.ts")

const run = async (
	args: readonly string[],
	cwd: string,
	env: Record<string, string> = {},
) => {
	const child = Bun.spawn([...args], {
		cwd,
		env: { ...process.env, ...env },
		stdout: "pipe",
		stderr: "pipe",
	})
	const [, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	])
	if (exitCode !== 0) {
		throw new Error(stderr.trim() || `Command failed: ${args.join(" ")}`)
	}
}

const createWorkbase = async (taskCount: number) => {
	const root = await mkdtemp(join(tmpdir(), "agency-pr-benchmark-"))
	const source = join(root, "source")
	const remote = join(root, "remote.git")
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
	await run(["git", "clone", "--bare", source, remote], root)
	await mkdir(join(root, "repos"))
	await run(
		["git", "clone", "--bare", remote, join(root, "repos/agency")],
		root,
	)
	await Bun.write(join(root, "agency.json"), '{"version":2}\n')

	for (let index = 1; index <= taskCount; index += 1) {
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

	const bin = join(root, "bin")
	await mkdir(bin)
	await Bun.write(
		join(bin, "gh"),
		`#!/bin/sh
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  printf 'https://github.com/example/agency/pull/1\n'
fi
`,
	)
	await chmod(join(bin, "gh"), 0o755)
	return { root, path: `${bin}:${process.env.PATH ?? ""}` }
}

const median = (samples: readonly number[]) =>
	[...samples].sort((left, right) => left - right)[
		Math.floor(samples.length / 2)
	]!

const measure = async (operation: () => Promise<void>) => {
	await operation()
	const samples: number[] = []
	for (let index = 0; index < sampleCount; index += 1) {
		const start = performance.now()
		await operation()
		samples.push(performance.now() - start)
	}
	return {
		medianMs: Math.round(median(samples)),
		samplesMs: samples.map(Math.round),
	}
}

const passthroughRoot = await createWorkbase(1)
try {
	const passthrough = await measure(() =>
		run(
			[process.execPath, cliPath, "pr", "list"],
			join(passthroughRoot.root, "tasks/benchmark-1"),
			{ PATH: passthroughRoot.path },
		),
	)

	const creationResults: Record<string, unknown> = {}
	for (const taskCount of [1, 50]) {
		const samples: number[] = []
		for (let index = 0; index < sampleCount; index += 1) {
			const workbase = await createWorkbase(taskCount)
			try {
				const start = performance.now()
				await run(
					[process.execPath, cliPath, "pr", "create", "benchmark-1"],
					workbase.root,
					{ PATH: workbase.path },
				)
				samples.push(performance.now() - start)
			} finally {
				await rm(workbase.root, { recursive: true, force: true })
			}
		}
		creationResults[taskCount === 1 ? "small" : "large"] = {
			taskCount,
			medianMs: Math.round(median(samples)),
			samplesMs: samples.map(Math.round),
		}
	}

	console.log(
		JSON.stringify(
			{ sampleCount, passthrough, creation: creationResults },
			null,
			2,
		),
	)
} finally {
	await rm(passthroughRoot.root, { recursive: true, force: true })
}
