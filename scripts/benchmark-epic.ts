import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const sampleCount = 3
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const cliPath = join(projectRoot, "cli.ts")

const sizes = [
	{ name: "small", epicCount: 3, tasksPerEpic: 5 },
	{ name: "large", epicCount: 10, tasksPerEpic: 20 },
] as const

const run = async (args: readonly string[], cwd: string) => {
	const child = Bun.spawn([...args], { cwd, stdout: "ignore", stderr: "pipe" })
	await child.exited
	if (child.exitCode !== 0) {
		throw new Error(
			(await new Response(child.stderr).text()).trim() ||
				`Command failed: ${args.join(" ")}`,
		)
	}
}

const createWorkbase = async (epicCount: number, tasksPerEpic: number) => {
	const root = await mkdtemp(join(tmpdir(), "agency-epic-benchmark-"))
	await mkdir(join(root, "repos", "agency"), { recursive: true })
	await Bun.write(join(root, "agency.json"), '{"version":2}\n')
	for (let epicIndex = 1; epicIndex <= epicCount; epicIndex += 1) {
		const epicId = `epic-${epicIndex}`
		const tasks = []
		for (let taskIndex = 1; taskIndex <= tasksPerEpic; taskIndex += 1) {
			const taskId = `${epicId}-task-${taskIndex}`
			tasks.push({
				id: taskId,
				...(taskIndex > 1
					? { dependsOn: [`${epicId}-task-${taskIndex - 1}`] }
					: {}),
			})
			const taskPath = join(root, "tasks", taskId)
			await mkdir(taskPath, { recursive: true })
			await Bun.write(
				join(taskPath, "TASK.md"),
				`---\nepic: ${epicId}\nticketUrl: null\nrepo: agency\nbranch: task/${taskId}\nbase: main\npr: null\nstatus: open\n---\n\n# ${taskId}\n`,
			)
		}
		const epicPath = join(root, "epics", epicId)
		await mkdir(epicPath, { recursive: true })
		await Bun.write(
			join(epicPath, "EPIC.md"),
			`---\nticketUrl: https://example.com/${epicId}\nrepos:\n  - repo: agency\n    ref: main\ntasks:\n${tasks
				.map(
					(task) =>
						`  - id: ${task.id}${task.dependsOn ? `\n    dependsOn:\n      - ${task.dependsOn[0]}` : ""}`,
				)
				.join("\n")}\n---\n\n# ${epicId}\n`,
		)
	}
	return root
}

const median = (samples: readonly number[]) =>
	[...samples].sort((left, right) => left - right)[
		Math.floor(samples.length / 2)
	]!

const measure = async (root: string, args: readonly string[]) => {
	const samples: number[] = []
	for (let index = 0; index < sampleCount; index += 1) {
		const start = performance.now()
		await run([process.execPath, cliPath, ...args], root)
		samples.push(performance.now() - start)
	}
	return {
		medianMs: Math.round(median(samples)),
		samplesMs: samples.map(Math.round),
	}
}

const results = []
for (const size of sizes) {
	const root = await createWorkbase(size.epicCount, size.tasksPerEpic)
	try {
		results.push({
			...size,
			documentCount: size.epicCount * (size.tasksPerEpic + 1),
			cold: await measure(root, ["epic", "list", "--json"]),
			warm: await measure(root, ["epic", "list", "--json"]),
			validation: await measure(root, ["validate", "--json"]),
		})
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}

console.log(JSON.stringify({ sampleCount, results }, null, 2))
