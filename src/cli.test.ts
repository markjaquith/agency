import { afterEach, describe, expect, test } from "bun:test"
import { access, mkdir, realpath } from "node:fs/promises"
import { join } from "node:path"
import { cleanupTempDir, createTempDir } from "./test-utils"

const projectRoot = join(import.meta.dir, "..")
const cliPath = join(projectRoot, "cli.ts")

interface CliResult {
	exitCode: number
	stdout: string
	stderr: string
}

async function runCli(
	args: string[],
	cwd = projectRoot,
	env?: Record<string, string>,
): Promise<CliResult> {
	const subprocess = Bun.spawn([process.execPath, cliPath, ...args], {
		cwd,
		env: env ? { ...process.env, ...env } : undefined,
		stdout: "pipe",
		stderr: "pipe",
	})
	const [exitCode, stdout, stderr] = await Promise.all([
		subprocess.exited,
		new Response(subprocess.stdout).text(),
		new Response(subprocess.stderr).text(),
	])
	return { exitCode, stdout, stderr }
}

function parseJson(result: CliResult) {
	expect(result.exitCode).toBe(0)
	expect(result.stderr).toBe("")
	const envelope = JSON.parse(result.stdout)
	expect(envelope).toMatchObject({ version: 1, ok: true })
	return envelope.result
}

describe("CLI", () => {
	const tempDirs: string[] = []

	afterEach(async () => {
		await Promise.all(tempDirs.splice(0).map(cleanupTempDir))
	})

	test("reports version and routes top-level help with intentional statuses", async () => {
		const version = await runCli(["--version"])
		expect(version).toEqual({
			exitCode: 0,
			stdout: "v0.0.0-development\n",
			stderr: "",
		})

		const noArgs = await runCli([])
		expect(noArgs.exitCode).toBe(1)
		expect(noArgs.stdout).toContain("Usage: agency <command> [options]")
		expect(noArgs.stderr).toBe("")

		const help = await runCli(["--help"])
		expect(help.exitCode).toBe(0)
		expect(help.stdout).toContain("Usage: agency <command> [options]")
		expect(help.stderr).toBe("")
	})

	test("reports unknown commands and preserves tagged error messages", async () => {
		const unknown = await runCli(["unknown"])
		expect(unknown.exitCode).toBe(1)
		expect(unknown.stdout).toBe("")
		expect(unknown.stderr).toContain("Unknown command 'unknown'")
		expect(unknown.stderr).toContain("Usage: agency <command> [options]")

		const cwd = await createTempDir()
		tempDirs.push(cwd)
		const taggedError = await runCli(["repo", "list"], cwd)
		expect(taggedError.exitCode).toBe(1)
		expect(taggedError.stdout).toBe("")
		expect(taggedError.stderr).toContain("ⓘ No Agency workbase found from")
		expect(taggedError.stderr).not.toContain("An error has occurred")
	})

	test("coordinates claims through revision-guarded machine commands", async () => {
		const root = await createTempDir()
		tempDirs.push(root)
		await Bun.write(join(root, "agency.json"), '{"version":2}\n')
		await mkdir(join(root, "repos", "agency"), { recursive: true })
		parseJson(
			await runCli(
				["task", "create", "claimed", "--repo", "agency", "--json"],
				root,
			),
		)
		const context = parseJson(
			await runCli(["context", "tasks/claimed", "--json"], root),
		)
		const revision = context.documents.task.sha256
		const claimed = parseJson(
			await runCli(
				[
					"claim",
					"claimed",
					"--claimant",
					"orchestrator",
					"--runner",
					"agent",
					"--session-id",
					"job-1",
					"--revision",
					revision,
					"--json",
				],
				root,
			),
		)
		expect(claimed.claim).toMatchObject({
			claimant: "orchestrator",
			runner: "agent",
			sessionId: "job-1",
			state: "active",
		})

		const conflict = await runCli(
			[
				"claim",
				"claimed",
				"--claimant",
				"other",
				"--runner",
				"other-agent",
				"--session-id",
				"job-2",
				"--revision",
				claimed.revision,
				"--json",
			],
			root,
		)
		expect(conflict.exitCode).toBe(1)
		expect(JSON.parse(conflict.stdout)).toMatchObject({
			ok: false,
			error: {
				code: "CLAIM_CONFLICT",
				retryable: true,
				fields: { claim: { runner: "agent", sessionId: "job-1" } },
			},
		})

		const finished = parseJson(
			await runCli(
				[
					"finish",
					"claimed",
					"--session-id",
					"job-1",
					"--revision",
					claimed.revision,
					"--outcome",
					"done",
					"--json",
				],
				root,
			),
		)
		expect(finished.claim).toMatchObject({ state: "finished", outcome: "done" })
	})

	test("emits one versioned error envelope for usage and command failures", async () => {
		const usage = await runCli(["unknown", "--json"])
		expect(usage.exitCode).toBe(1)
		expect(usage.stderr).toBe("")
		expect(usage.stdout.trim().split("\n")).toHaveLength(1)
		expect(JSON.parse(usage.stdout)).toEqual({
			version: 1,
			ok: false,
			error: {
				code: "CLI_USAGE",
				message:
					"Unknown command 'unknown'.\n\nUsage: agency <command> [options]",
				fields: {
					detail: "Unknown command 'unknown'.",
					usage: "agency <command> [options]",
				},
				retryable: false,
				remediation:
					"Correct the arguments using the usage value in error.fields.",
			},
		})

		const cwd = await createTempDir()
		tempDirs.push(cwd)
		const commandFailure = await runCli(
			["repo", "list", "--json", "--silent"],
			cwd,
		)
		expect(commandFailure.exitCode).toBe(1)
		expect(commandFailure.stderr).toBe("")
		expect(JSON.parse(commandFailure.stdout)).toMatchObject({
			version: 1,
			ok: false,
			error: {
				code: "WORKBASE_NOT_FOUND",
				retryable: false,
			},
		})
	})

	test("rejects malformed input before running a command", async () => {
		const parent = await createTempDir()
		tempDirs.push(parent)
		const root = join(parent, "workbase")
		const result = await runCli(["init", root, "extra"])

		expect(result.exitCode).toBe(1)
		expect(result.stderr).toContain("Usage: agency init [path] [--json]")
		await expect(access(root)).rejects.toThrow()
	})

	test("resolves relative init paths from explicit cwd", async () => {
		const parent = await createTempDir()
		tempDirs.push(parent)
		const result = parseJson(
			await runCli(["init", "child", "--cwd", parent, "--json"], projectRoot),
		)
		expect(result.root).toBe(join(parent, "child"))
	})

	test("refuses guided input without a TTY or with --no-input", async () => {
		for (const args of [
			["task", "new"],
			["task", "new", "example", "--no-input"],
		]) {
			const result = await runCli(args)
			expect(result.exitCode).toBe(1)
			expect(result.stderr).toContain("task new requires interactive input")
			expect(result.stderr).toContain("agency task create")
		}
	})

	test("routes command help and global options on either side of commands", async () => {
		for (const [command, usage] of [
			["init", "Usage: agency init"],
			["workbase", "Usage: agency workbase"],
			["integration", "Usage: agency integration"],
			["repo", "Usage: agency repo"],
			["epic", "Usage: agency epic"],
			["task", "Usage: agency task"],
			["phase", "Usage: agency phase"],
			["archive", "Usage: agency archive"],
			["work", "Usage: agency work"],
			["pr", "Usage: agency pr"],
			["status", "Usage: agency status"],
			["validate", "Usage: agency validate"],
			["context", "Usage: agency context"],
			["graph", "Usage: agency graph"],
			["next", "Usage: agency next"],
		] as const) {
			const result = await runCli([command, "--help"])
			expect(result.exitCode).toBe(0)
			expect(result.stdout).toContain(usage)
			expect(result.stderr).toBe("")
		}

		const helpBefore = await runCli(["--help", "task"])
		expect(helpBefore.exitCode).toBe(0)
		expect(helpBefore.stdout).toContain("Usage: agency task <subcommand>")
		expect(helpBefore.stderr).toBe("")

		const root = await createTempDir()
		tempDirs.push(root)
		const before = await runCli(["--silent", "init", root])
		expect(before).toEqual({ exitCode: 0, stdout: "", stderr: "" })

		const after = await runCli(["status", "--silent"], root)
		expect(after).toEqual({ exitCode: 0, stdout: "", stderr: "" })
	}, 10_000)

	test("lists ready work and exposes excluded blockers through one result", async () => {
		const root = await createTempDir()
		tempDirs.push(root)
		await Bun.write(join(root, "agency.json"), '{"version":2}\n')
		await mkdir(join(root, "repos/agency"), { recursive: true })
		for (const id of ["ready", "finished"]) {
			parseJson(
				await runCli(
					["task", "create", id, "--repo", "agency", "--json"],
					root,
				),
			)
		}
		parseJson(
			await runCli(["task", "status", "finished", "done", "--json"], root),
		)

		const human = await runCli(["next"], root)
		expect(human).toMatchObject({ exitCode: 0, stderr: "" })
		expect(human.stdout).toContain("1. task/ready")
		expect(human.stdout).not.toContain("task/finished")

		const result = parseJson(await runCli(["next", "--select", "--json"], root))
		expect(result.selected).toMatchObject({ key: "task/ready", rank: 1 })
		expect(result.ready.map((item: any) => item.key)).toEqual(["task/ready"])
		expect(result.excluded).toMatchObject([
			{
				key: "task/finished",
				status: "done",
				terminal: true,
				blockers: [{ kind: "status", reason: "Task status is done" }],
			},
		])

		const blockedPr = await runCli(["pr", "create", "finished", "--json"], root)
		expect(blockedPr.exitCode).toBe(1)
		expect(blockedPr.stderr).toBe("")
		expect(JSON.parse(blockedPr.stdout)).toMatchObject({
			ok: false,
			error: {
				code: "EXECUTION_BLOCKED",
				fields: {
					status: "done",
					blockers: [{ kind: "status", reason: "Task status is done" }],
				},
			},
		})
	})

	test("reports and synchronizes managed integration files", async () => {
		const root = await createTempDir()
		tempDirs.push(root)
		expect((await runCli(["init", root])).exitCode).toBe(0)

		const before = parseJson(
			await runCli(["integration", "status", "--json"], root),
		)
		expect(before.files).toMatchObject([
			{ name: "agents", state: "missing" },
			{ name: "opencode", state: "missing" },
		])

		const synced = parseJson(
			await runCli(["integration", "sync", "--json"], root),
		)
		expect(synced.files).toMatchObject([
			{ name: "agents", state: "managed", changed: true },
			{ name: "opencode", state: "managed", changed: true },
		])
	})

	test("registers and lists workbases", async () => {
		const parent = await createTempDir()
		tempDirs.push(parent)
		const root = join(parent, "workbase")
		const env = { XDG_CONFIG_HOME: join(parent, "config") }

		expect(
			parseJson(await runCli(["init", root, "--json"], parent, env)),
		).toEqual({
			root,
		})
		const registration = parseJson(
			await runCli(
				[
					"workbase",
					"add",
					"workbase",
					"--cwd",
					parent,
					"--name",
					"primary",
					"--json",
				],
				projectRoot,
				env,
			),
		)
		expect(registration).toMatchObject({
			name: "primary",
			path: await realpath(root),
		})
		expect(
			parseJson(await runCli(["workbase", "list", "--json"], parent, env)),
		).toEqual({ workbases: [registration] })

		await mkdir(join(root, "repos", "agency"), { recursive: true })
		parseJson(
			await runCli(
				[
					"task",
					"create",
					"explicit",
					"--repo",
					"agency",
					"--workbase",
					"primary",
					"--no-input",
					"--json",
				],
				parent,
				env,
			),
		)
		const shown = parseJson(
			await runCli(
				[
					"task",
					"show",
					"--task",
					"explicit",
					"--workbase",
					registration.id,
					"--no-input",
					"--json",
				],
				parent,
				env,
			),
		)
		expect(shown.id).toBe("explicit")
		const inferred = parseJson(
			await runCli(
				["context", "--cwd", join(root, "tasks", "explicit"), "--json"],
				projectRoot,
				env,
			),
		)
		expect(inferred.target).toMatchObject({
			kind: "task",
			taskId: "explicit",
		})

		parseJson(
			await runCli(["workbase", "default", "primary", "--json"], parent, env),
		)
		expect(
			parseJson(await runCli(["task", "list", "--json"], parent, env)),
		).toHaveLength(1)
		const explicitOutside = await runCli(
			["task", "list", "--cwd", parent, "--json"],
			projectRoot,
			env,
		)
		expect(explicitOutside.exitCode).toBe(1)
		expect(explicitOutside.stderr).toBe("")
		expect(JSON.parse(explicitOutside.stdout).error.message).toContain(
			"No Agency workbase found from",
		)
	})

	test("exports equivalent JSON and JSONL graph contracts", async () => {
		const root = await createTempDir()
		tempDirs.push(root)
		expect((await runCli(["init", root])).exitCode).toBe(0)
		await mkdir(join(root, "repos/agency"), { recursive: true })
		await mkdir(join(root, "tasks/example"), { recursive: true })
		await Bun.write(
			join(root, "tasks/example/TASK.md"),
			`---
ticketUrl: null
repo: agency
branch: feat/example
base: main
pr: null
status: open
---

# Example
`,
		)

		const json = parseJson(
			await runCli(
				["graph", "--json", "--include", "bodies", "--kind", "task"],
				root,
			),
		)
		expect(json).toMatchObject({
			version: 1,
			includes: ["bodies"],
			nodes: [
				{ id: "task:example", body: expect.stringContaining("# Example") },
			],
			edges: [],
		})

		const streamed = await runCli(
			["graph", "--jsonl", "--include", "bodies", "--kind", "task"],
			root,
		)
		expect(streamed.exitCode).toBe(0)
		expect(streamed.stderr).toBe("")
		const records = streamed.stdout
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line))
		expect(records.map((record) => record.type)).toEqual([
			"meta",
			"node",
			"end",
		])
		const reconstructed = {
			...records[0].graph,
			nodes: records
				.filter((record) => record.type === "node")
				.map((record) => record.node),
			edges: records
				.filter((record) => record.type === "edge")
				.map((record) => record.edge),
		}
		expect(reconstructed).toEqual(json)
	})

	test("lets JSON override silent and disables interactive task input", async () => {
		const root = await createTempDir()
		tempDirs.push(root)
		const result = await runCli(["init", root, "--json", "--silent"])
		expect(parseJson(result)).toEqual({ root })

		const interactive = await runCli(["task", "new", "--json"])
		expect(interactive.exitCode).toBe(1)
		expect(interactive.stderr).toBe("")
		expect(JSON.parse(interactive.stdout)).toMatchObject({
			version: 1,
			ok: false,
			error: { code: "COMMAND_FAILED", retryable: false },
		})
	})

	test("prepares a workspace and reports a non-mutating dry-run", async () => {
		const parent = await createTempDir()
		tempDirs.push(parent)
		const root = join(parent, "workbase")
		const source = join(parent, "source")
		expect(
			Bun.spawnSync(["git", "init", "--initial-branch=main", source]).exitCode,
		).toBe(0)
		await Bun.write(join(source, "README.md"), "example\n")
		for (const args of [
			["config", "user.email", "test@example.com"],
			["config", "user.name", "Test"],
			["add", "README.md"],
			["-c", "commit.gpgsign=false", "commit", "-m", "initial"],
		]) {
			expect(Bun.spawnSync(["git", "-C", source, ...args]).exitCode).toBe(0)
		}

		parseJson(await runCli(["init", root, "--json"], parent))
		parseJson(await runCli(["repo", "link", "agency", source, "--json"], root))
		parseJson(
			await runCli(
				[
					"task",
					"create",
					"example",
					"--repo",
					"agency",
					"--branch",
					"feat/example",
					"--base",
					"main",
					"--json",
				],
				root,
			),
		)

		const planned = parseJson(
			await runCli(["work", "prepare", "example", "--dry-run", "--json"], root),
		)
		const workbaseRoot = await realpath(root)
		expect(planned).toMatchObject({
			dryRun: true,
			taskPath: join(workbaseRoot, "tasks/example/TASK.md"),
			phasePath: null,
			checkouts: [
				{
					repo: "agency",
					kind: "writable",
					action: "created",
					resolvedCommit: expect.stringMatching(/^[0-9a-f]{40}$/),
				},
			],
		})
		await expect(access(join(root, "tasks/example/code"))).rejects.toThrow()

		const prepared = parseJson(
			await runCli(["work", "prepare", "example", "--json"], root),
		)
		expect(prepared).toMatchObject({
			dryRun: false,
			checkouts: [{ action: "created", kind: "writable" }],
		})
		const task = parseJson(
			await runCli(["task", "show", "example", "--json"], root),
		)
		expect(task.data.status).toBe("open")
	})

	test("envelopes help and version output in machine mode", async () => {
		const help = await runCli(["status", "--help", "--json"])
		expect(parseJson(help)).toContain("Usage: agency status")

		const version = await runCli(["status", "--version", "--json"])
		expect(parseJson(version)).toEqual({ version: "0.0.0-development" })

		const jsonlHelp = await runCli(["graph", "--help", "--jsonl"])
		expect(parseJson(jsonlHelp)).toContain("Usage: agency graph")

		const invalidJsonl = await runCli([
			"graph",
			"--jsonl",
			"--include",
			"secrets",
		])
		expect(invalidJsonl.exitCode).toBe(1)
		expect(invalidJsonl.stderr).toBe("")
		expect(invalidJsonl.stdout.trim().split("\n")).toHaveLength(1)
		expect(JSON.parse(invalidJsonl.stdout)).toMatchObject({
			version: 1,
			ok: false,
			error: { code: "CLI_USAGE" },
		})
	})

	test("runs a multi-phase domain workflow through subprocesses", async () => {
		const parent = await createTempDir()
		tempDirs.push(parent)
		const root = join(parent, "workbase")
		const source = join(parent, "source")

		const git = Bun.spawn(["git", "init", "--initial-branch=main", source], {
			stdout: "ignore",
			stderr: "pipe",
		})
		expect(await git.exited).toBe(0)

		expect(parseJson(await runCli(["init", root, "--json"]))).toEqual({
			root,
		})
		const workbaseRoot = await realpath(root)
		expect(
			parseJson(
				await runCli(["repo", "link", "agency", source, "--json"], root),
			),
		).toEqual({
			alias: "agency",
			path: join(workbaseRoot, "repos/agency"),
		})
		for (const alias of ["effect", "tooling"]) {
			parseJson(await runCli(["repo", "link", alias, source, "--json"], root))
		}

		const epic = parseJson(
			await runCli(
				[
					"epic",
					"create",
					"delivery",
					"--ticket-url",
					"https://example.com/epics/delivery",
					"--repo",
					"agency:main",
					"--json",
				],
				root,
			),
		)
		expect(epic).toMatchObject({
			id: "delivery",
			data: { repos: [{ repo: "agency", ref: "main" }], tasks: [] },
		})

		const task = parseJson(
			await runCli(
				[
					"task",
					"create",
					"ship",
					"--ticket-url",
					"https://example.com/tasks/ship",
					"--epic",
					"delivery",
					"--multi-phase",
					"--json",
				],
				root,
			),
		)
		expect(task).toMatchObject({
			id: "ship",
			data: { epic: "delivery", phases: [] },
		})

		for (const [id, branch] of [
			["prepare", "task/ship-prepare"],
			["implement", "task/ship-implement"],
		] as const) {
			const phase = parseJson(
				await runCli(
					[
						"phase",
						"create",
						"ship",
						id,
						"--repo",
						"agency",
						"--branch",
						branch,
						"--base",
						"main",
						"--json",
					],
					root,
				),
			)
			expect(phase).toMatchObject({ taskId: "ship", id })
		}

		const release = parseJson(
			await runCli(
				[
					"phase",
					"create",
					"ship",
					"release",
					"--repo",
					"agency",
					"--branch",
					"task/ship-release",
					"--base",
					"main",
					"--depends-on",
					"prepare",
					"--depends-on",
					"implement",
					"--reference",
					"effect:main",
					"--reference",
					"tooling:main",
					"--json",
				],
				root,
			),
		)
		expect(release.data).toMatchObject({
			branch: "task/ship-release",
			base: "main",
			repos: [
				{ repo: "effect", ref: "main" },
				{ repo: "tooling", ref: "main" },
			],
		})

		const epicList = parseJson(await runCli(["epic", "list", "--json"], root))
		expect(epicList).toHaveLength(1)
		expect(epicList[0].data.tasks).toEqual([{ id: "ship" }])

		const taskShow = parseJson(
			await runCli(["task", "show", "ship", "--json"], root),
		)
		expect(taskShow.data.phases).toEqual([
			{ id: "prepare" },
			{ id: "implement" },
			{ id: "release", dependsOn: ["prepare", "implement"] },
		])
		const plainTaskShow = await runCli(["task", "show", "ship"], root)
		expect(plainTaskShow.exitCode).toBe(0)
		expect(plainTaskShow.stdout).toContain(
			"ticketUrl: https://example.com/tasks/ship",
		)
		expect(plainTaskShow.stderr).toBe("")

		const phaseList = parseJson(
			await runCli(["phase", "list", "ship", "--json"], root),
		)
		expect(phaseList.map((phase: { id: string }) => phase.id)).toEqual([
			"implement",
			"prepare",
			"release",
		])

		const phaseShow = parseJson(
			await runCli(["phase", "show", "ship", "release", "--json"], root),
		)
		expect(phaseShow).toMatchObject({ taskId: "ship", id: "release" })

		const status = parseJson(await runCli(["status", "--json"], root))
		expect(status).toMatchObject({
			root: workbaseRoot,
			epicCount: 1,
			taskCount: 1,
			phaseCount: 3,
			valid: true,
			issues: [],
		})

		const validation = parseJson(
			await runCli(["validate", root, "--json"], parent),
		)
		expect(validation).toEqual({
			root,
			issues: [],
			epicCount: 1,
			taskCount: 1,
			phaseCount: 3,
			valid: true,
		})
	}, 30_000)
})
