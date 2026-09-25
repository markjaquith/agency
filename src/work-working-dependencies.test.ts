import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, rm, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { cleanupTempDir, createTempDir } from "./test-utils"

const cliPath = join(import.meta.dir, "../cli.ts")
const flag = "--allow-working-dependencies"
const roots: string[] = []

afterEach(async () => {
	await Promise.all(roots.splice(0).map(cleanupTempDir))
})

const write = async (path: string, content: string) => {
	await mkdir(dirname(path), { recursive: true })
	await Bun.write(path, content)
}

const git = async (cwd: string, ...args: string[]) => {
	const child = Bun.spawn(["git", "-C", cwd, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	})
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	])
	expect(exitCode, stderr).toBe(0)
	return stdout.trim()
}

const fixture = async (kind: "task" | "phase") => {
	const root = await createTempDir()
	roots.push(root)
	const source = join(root, "source")
	await mkdir(source)
	await git(source, "init", "--initial-branch=main")
	await write(join(source, "README.md"), "fixture\n")
	await git(source, "add", "README.md")
	await git(
		source,
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.com",
		"-c",
		"commit.gpgsign=false",
		"commit",
		"-m",
		"fixture",
	)
	await mkdir(join(root, "repos"))
	await git(root, "clone", "--bare", source, join(root, "repos/agency"))
	const command = [
		process.execPath,
		"-e",
		'await Bun.write("{workbase}/runner-target", "{target}")',
	]
	await write(
		join(root, "agency.json"),
		JSON.stringify({
			version: 2,
			agents: { mock: { command, autoCommand: command } },
		}),
	)
	const document = (id: string) =>
		kind === "task"
			? join(root, `tasks/${id}/TASK.md`)
			: join(root, `tasks/pipeline/phases/${id}/PHASE.md`)
	const setStatus = (id: string, status: string, repo = "agency") =>
		write(
			document(id),
			`---\n${kind === "task" ? "ticketUrl: null\nepic: delivery\n" : ""}repo: ${repo}\nbranch: task/${id}\nbase: main\npr: null\nstatus: ${status}\n---\n\n# ${id}\n`,
		)
	const declarations =
		"  - id: dependency\n  - id: second\n  - id: target\n    dependsOn: [dependency, second]\n"
	if (kind === "task") {
		await write(
			join(root, "epics/delivery/EPIC.md"),
			`---\nticketUrl: https://example.com/delivery\nrepos:\n  - repo: agency\n    ref: main\ntasks:\n${declarations}---\n\n# Delivery\n`,
		)
	} else {
		await write(
			join(root, "tasks/pipeline/TASK.md"),
			`---\nticketUrl: null\nphases:\n${declarations}---\n\n# Pipeline\n`,
		)
	}
	await setStatus("dependency", "working")
	await setStatus("second", "done")
	await setStatus("target", "open")
	const selector =
		kind === "task" ? ["target"] : ["--task", "pipeline", "--phase", "target"]
	const target =
		kind === "task"
			? "execution-unit:task/target"
			: "execution-unit:phase/pipeline/target"
	const lockKey = Buffer.from(
		kind === "task" ? "target:task" : "pipeline:target",
	).toString("hex")
	const lockPath = join(root, `.agency-worktree-${lockKey}.lock`)
	const checkout = join(dirname(document("target")), "code/agency")
	const run = async (args: string[], cwd = root) => {
		const env: NodeJS.ProcessEnv = {
			...process.env,
			XDG_CONFIG_HOME: join(root, "config"),
			XDG_STATE_HOME: join(root, "state"),
			AGENCY_NO_USAGE_LOG: "1",
		}
		for (const key of Object.keys(env)) {
			if (key.startsWith("AGENCY_") && key !== "AGENCY_NO_USAGE_LOG")
				delete env[key]
		}
		const child = Bun.spawn(
			[process.execPath, cliPath, ...args, "--no-input"],
			{ cwd, env, stdout: "pipe", stderr: "pipe" },
		)
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		])
		return { exitCode, stdout, stderr }
	}
	return {
		root,
		document,
		setStatus,
		selector,
		target,
		lockPath,
		checkout,
		run,
	}
}

const result = (response: {
	exitCode: number
	stdout: string
	stderr: string
}) => {
	expect(response.exitCode, JSON.stringify(response)).toBe(0)
	expect(response.stderr).toBe("")
	const envelope = JSON.parse(response.stdout)
	expect(envelope).toMatchObject({ version: 1, ok: true })
	return envelope.result
}

describe("working dependency opt-in through the source CLI", () => {
	for (const kind of ["task", "phase"] as const) {
		test(`${kind}: prepares, preserves locks/evidence boundaries, and launches only a mock runner`, async () => {
			const f = await fixture(kind)
			const prepare = ["work", "prepare", ...f.selector, "--json"]
			const blocked = await f.run([...prepare, "--dry-run"])
			expect(blocked.exitCode).toBe(1)
			expect(JSON.parse(blocked.stdout)).toMatchObject({
				error: {
					fields: {
						blockers: expect.arrayContaining([
							expect.objectContaining({
								kind: "dependency",
								status: "working",
							}),
						]),
					},
				},
			})
			const planned = result(await f.run([...prepare, flag, "--dry-run"]))
			expect(planned).toMatchObject({
				dryRun: true,
				execution: { mode: "preview", workspace: { state: "planned" } },
			})
			expect(planned.execution.commands.work.argv).toEqual([
				"agency",
				"work",
				".",
				"--auto",
				flag,
			])
			expect(planned.validationEvidence.evidence).not.toHaveProperty(
				"allowWorkingDependencies",
			)
			expect(await Bun.file(join(f.checkout, "README.md")).exists()).toBe(false)
			const evidence = [
				"--evidence",
				JSON.stringify(planned.validationEvidence.evidence),
			]
			const reused = result(
				await f.run([...prepare, flag, "--dry-run", ...evidence]),
			)
			expect(reused.validationEvidence).toMatchObject({
				status: "reused",
				reasons: [],
			})
			expect(
				(await f.run([...prepare, "--dry-run", ...evidence])).exitCode,
			).toBe(1)

			await write(f.lockPath, "active owner sentinel\n")
			const before = await stat(f.lockPath)
			for (const args of [
				[...prepare, flag, "--dry-run", ...evidence],
				[...prepare, flag, ...evidence],
				["work", ...f.selector, flag, "--agent", "mock"],
			]) {
				const locked = await f.run(args)
				expect(locked.exitCode, JSON.stringify(locked)).toBe(1)
				expect(locked.stdout + locked.stderr).toContain(
					"Another worktree operation is in progress",
				)
				expect(await Bun.file(f.lockPath).text()).toBe(
					"active owner sentinel\n",
				)
				expect((await stat(f.lockPath)).ino).toBe(before.ino)
				expect(await Bun.file(join(f.checkout, "README.md")).exists()).toBe(
					false,
				)
				expect(await Bun.file(f.document("target")).text()).toContain(
					"status: open",
				)
				expect(await Bun.file(join(f.root, "runner-target")).exists()).toBe(
					false,
				)
			}
			for (const args of [
				[...prepare, flag, "--force", "--dry-run"],
				["work", ...f.selector, flag, "--force", "--agent", "mock"],
			]) {
				const conflict = await f.run(args)
				expect(conflict.exitCode).toBe(1)
				expect(conflict.stdout + conflict.stderr).toContain(
					"cannot be combined",
				)
				expect(await Bun.file(f.lockPath).text()).toBe(
					"active owner sentinel\n",
				)
				expect((await stat(f.lockPath)).ino).toBe(before.ino)
			}
			await rm(f.lockPath)
			const applied = result(await f.run([...prepare, flag, ...evidence]))
			expect(applied).toMatchObject({
				dryRun: false,
				execution: {
					mode: "applied",
					executionIdentity: planned.execution.executionIdentity,
				},
			})
			expect(await Bun.file(f.document("target")).text()).toContain(
				"status: open",
			)
			expect(await Bun.file(f.document("dependency")).text()).toContain(
				"status: working",
			)
			const context = result(
				await f.run(["context", f.document("target"), "--json"]),
			)
			expect(context.graph.readiness).toMatchObject({
				ready: false,
				blocked: true,
			})
			expect(await Bun.file(join(f.root, "runner-target")).exists()).toBe(false)
			const work = applied.execution.commands.work
			const launched = await f.run(
				[...work.argv.slice(1), "--agent", "mock"],
				work.cwd,
			)
			expect(launched.exitCode, JSON.stringify(launched)).toBe(0)
			expect(await Bun.file(join(f.root, "runner-target")).text()).toBe(
				f.target,
			)
			expect(await Bun.file(f.document("target")).text()).toContain(
				"status: working",
			)

			// Reusing a working checkout must preserve ordinary resumability and edits.
			await write(join(f.checkout, "README.md"), "in-progress edits\n")
			for (const optIn of [[], [flag]]) {
				expect(
					(await f.run(["work", ...f.selector, ...optIn, "--agent", "mock"]))
						.exitCode,
				).toBe(0)
				expect(await Bun.file(join(f.checkout, "README.md")).text()).toBe(
					"in-progress edits\n",
				)
			}
			expect(await git(f.checkout, "status", "--porcelain")).toContain(
				"README.md",
			)
		}, 60_000)
	}

	test("rejects dependency, lifecycle, validation and selection blockers even with evidence", async () => {
		const f = await fixture("phase")
		const prepare = [
			"work",
			"prepare",
			...f.selector,
			flag,
			"--dry-run",
			"--json",
		]
		const planned = result(await f.run(prepare))
		const evidence = [
			"--evidence",
			JSON.stringify(planned.validationEvidence.evidence),
		]
		for (const status of ["open", "delegated", "dropped"]) {
			await f.setStatus("second", status)
			const rejected = await f.run([...prepare, ...evidence])
			expect(rejected.exitCode).toBe(1)
			expect(rejected.stdout).toContain(`Phase dependency is ${status}`)
		}
		await f.setStatus("second", "working")
		const changed = result(await f.run([...prepare, ...evidence]))
		expect(changed.validationEvidence).toMatchObject({
			status: "refreshed",
			reasons: ["workbase-revision-changed"],
		})
		for (const status of ["done", "dropped", "delegated"]) {
			await f.setStatus("target", status)
			const rejected = await f.run([...prepare, ...evidence])
			expect(rejected.exitCode).toBe(1)
			expect(rejected.stdout).toContain(`Phase status is ${status}`)
			expect(
				(await f.run(["work", ...f.selector, flag, "--agent", "mock"]))
					.exitCode,
			).toBe(1)
			expect(await Bun.file(f.document("target")).text()).toContain(
				`status: ${status}`,
			)
		}
		await f.setStatus("target", "open", "missing")
		const invalid = await f.run([...prepare, ...evidence])
		expect(invalid.exitCode).toBe(1)
		expect(invalid.stdout).toContain("Recalled repository conflicts")
		const invalidWithoutEvidence = await f.run(prepare)
		expect(invalidWithoutEvidence.exitCode).toBe(1)
		expect(JSON.parse(invalidWithoutEvidence.stdout)).toMatchObject({
			ok: false,
			error: { code: "VALIDATION_FAILED" },
		})
		expect(
			(await f.run(["work", ...f.selector, flag, "--agent", "mock"])).exitCode,
		).toBe(1)
		await f.setStatus("target", "open")
		await rm(f.document("second"))
		expect((await f.run([...prepare, ...evidence])).exitCode).toBe(1)
		expect(
			(await f.run(["work", ...f.selector, flag, "--agent", "mock"])).exitCode,
		).toBe(1)
		await f.setStatus("second", "done")
		await f.setStatus("dependency", "done")
		expect(result(await f.run(prepare)).dryRun).toBe(true)
		for (const args of [
			["work", flag],
			["work", "prepare", flag, "--json"],
			[...prepare, "--force"],
			["work", ...f.selector, flag, "--force"],
			["work", "pipeline", flag],
			["work", ".", flag],
		])
			expect((await f.run(args)).exitCode).toBe(1)
		expect(await Bun.file(join(f.checkout, "README.md")).exists()).toBe(false)
		expect(await Bun.file(join(f.root, "runner-target")).exists()).toBe(false)
	}, 60_000)

	test("does not bypass conflicting branch ownership or disturb its dirty checkout", async () => {
		const f = await fixture("phase")
		const foreign = join(f.root, "foreign-checkout")
		await git(
			join(f.root, "repos/agency"),
			"worktree",
			"add",
			"-b",
			"task/target",
			foreign,
			"main",
		)
		await write(join(foreign, "README.md"), "another owner's edits\n")
		for (const args of [
			["work", "prepare", ...f.selector, flag, "--dry-run", "--json"],
			["work", "prepare", ...f.selector, flag, "--json"],
			["work", ...f.selector, flag, "--agent", "mock"],
		]) {
			const rejected = await f.run(args)
			expect(rejected.exitCode).toBe(1)
			expect(rejected.stdout + rejected.stderr).toContain("already checked out")
			expect(await Bun.file(join(foreign, "README.md")).text()).toBe(
				"another owner's edits\n",
			)
			expect(await Bun.file(f.document("target")).text()).toContain(
				"status: open",
			)
		}
		expect(await Bun.file(join(f.checkout, "README.md")).exists()).toBe(false)
		expect(await Bun.file(join(f.root, "runner-target")).exists()).toBe(false)
	}, 30_000)

	test("does not repair a wrong-branch dirty checkout during preparation or launch", async () => {
		const f = await fixture("phase")
		const prepare = ["work", "prepare", ...f.selector, flag, "--json"]
		result(await f.run(prepare))
		await git(f.checkout, "switch", "-c", "other-work")
		await write(join(f.checkout, "README.md"), "keep dirty checkout\n")
		for (const args of [
			[...prepare, "--dry-run"],
			prepare,
			["work", ...f.selector, flag, "--agent", "mock"],
		]) {
			const rejected = await f.run(args)
			expect(rejected.exitCode).toBe(1)
			expect(rejected.stdout + rejected.stderr).toContain(
				"not registered to branch 'task/target'",
			)
			expect(await Bun.file(join(f.checkout, "README.md")).text()).toBe(
				"keep dirty checkout\n",
			)
			expect(await git(f.checkout, "branch", "--show-current")).toBe(
				"other-work",
			)
			expect(await Bun.file(f.document("target")).text()).toContain(
				"status: open",
			)
		}
		expect(await Bun.file(join(f.root, "runner-target")).exists()).toBe(false)
	}, 30_000)
})
