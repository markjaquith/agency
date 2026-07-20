import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { access, mkdir, realpath } from "node:fs/promises"
import { join, relative } from "node:path"
import errorFixture from "../fixtures/protocol/error.json"
import successFixture from "../fixtures/protocol/success.json"
import { cleanupTempDir, createTempDir } from "./test-utils"

const projectRoot = join(import.meta.dir, "..")
const cliPath = join(projectRoot, "cli.ts")
const isolatedConfigHome = await createTempDir()

afterAll(() => cleanupTempDir(isolatedConfigHome))

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
		env: {
			...process.env,
			XDG_CONFIG_HOME: isolatedConfigHome,
			...env,
		},
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
	expect(result.exitCode, JSON.stringify(result)).toBe(0)
	expect(result.stderr).toBe("")
	const envelope = JSON.parse(result.stdout)
	expect(envelope).toMatchObject({ version: 1, ok: true })
	return envelope.result
}

async function runGit(args: string[]) {
	const subprocess = Bun.spawn(["git", ...args], {
		stdout: "pipe",
		stderr: "pipe",
	})
	const [exitCode, stdout, stderr] = await Promise.all([
		subprocess.exited,
		new Response(subprocess.stdout).text(),
		new Response(subprocess.stderr).text(),
	])
	if (exitCode !== 0) throw new Error(stderr)
	return stdout
}

async function startGitDaemon(basePath: string) {
	const port = 20000 + Math.floor(Math.random() * 20000)
	const process = Bun.spawn(
		[
			"git",
			"daemon",
			"--reuseaddr",
			"--export-all",
			`--base-path=${basePath}`,
			"--listen=127.0.0.1",
			`--port=${port}`,
			basePath,
		],
		{ stdout: "pipe", stderr: "pipe" },
	)
	const remote = `git://127.0.0.1:${port}/source.git`
	for (let attempt = 0; attempt < 40; attempt++) {
		const probe = Bun.spawn(["git", "ls-remote", remote], {
			stdout: "ignore",
			stderr: "ignore",
		})
		if ((await probe.exited) === 0) return { process, remote }
		await Bun.sleep(25)
	}
	process.kill()
	throw new Error("Git daemon did not start")
}

describe("CLI", () => {
	const tempDirs: string[] = []
	const daemons: Bun.Subprocess[] = []

	afterEach(async () => {
		await Promise.all(
			daemons.splice(0).map(async (daemon) => {
				daemon.kill()
				await daemon.exited
			}),
		)
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

	test("keeps the published protocol fixtures synchronized with CLI output", async () => {
		const parent = await createTempDir()
		tempDirs.push(parent)
		const root = join(parent, "workbase")
		const success = await runCli(["init", root, "--json"], parent)
		expect(success.exitCode).toBe(0)
		expect(success.stderr).toBe("")
		expect(success.stdout.endsWith("\n")).toBe(true)
		const successEnvelope = JSON.parse(success.stdout)
		expect(successEnvelope.result.root).toBe(root)
		expect({
			...successEnvelope,
			result: { ...successEnvelope.result, root: "/work/agency" },
		}).toEqual(successFixture)

		const failure = await runCli(["unknown", "--json"])
		expect(failure.exitCode).toBe(1)
		expect(failure.stderr).toBe("")
		expect(failure.stdout.endsWith("\n")).toBe(true)
		expect(JSON.parse(failure.stdout)).toEqual(errorFixture)
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

	test("routes graph mutations through structured output", async () => {
		const root = await createTempDir()
		tempDirs.push(root)
		await Bun.write(join(root, "agency.json"), '{"version":2}\n')
		await mkdir(join(root, "repos", "agency"), { recursive: true })
		parseJson(
			await runCli(
				[
					"epic",
					"create",
					"delivery",
					"--ticket-url",
					"https://example.com/delivery",
					"--repo",
					"agency:main",
					"--json",
				],
				root,
			),
		)
		for (const id of ["first", "second"]) {
			parseJson(
				await runCli(
					[
						"task",
						"create",
						id,
						"--repo",
						"agency",
						"--epic",
						"delivery",
						"--json",
					],
					root,
				),
			)
		}
		const observed = parseJson(
			await runCli(["task", "show", "second", "--json"], root),
		)
		const taskPath = join(root, "tasks/second/TASK.md")
		await Bun.write(
			taskPath,
			`${await Bun.file(taskPath).text()}\nConcurrent edit.\n`,
		)
		const conflict = await runCli(
			[
				"task",
				"update",
				"second",
				"--description",
				"Stale update",
				"--if-revision",
				observed.revision,
				"--json",
			],
			root,
		)
		expect(conflict.exitCode).toBe(1)
		expect(JSON.parse(conflict.stdout)).toMatchObject({
			ok: false,
			error: {
				code: "REVISION_CONFLICT",
				retryable: true,
				fields: {
					path: "tasks/second/TASK.md",
					expectedRevision: observed.revision,
					currentRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
				},
			},
		})
		expect(await Bun.file(taskPath).text()).toContain("Concurrent edit.")

		const updated = parseJson(
			await runCli(
				["task", "update", "second", "--description", "Revised", "--json"],
				root,
			),
		)
		expect(updated).toMatchObject({
			operation: "task.update",
			entity: { kind: "task", id: "second" },
			validation: { valid: true, scope: ["tasks/second/TASK.md"] },
		})

		const dependency = parseJson(
			await runCli(
				["task", "dependency", "add", "second", "first", "--json"],
				root,
			),
		)
		expect(dependency).toMatchObject({
			operation: "task.dependency.add",
			changedPaths: ["epics/delivery/EPIC.md"],
		})
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
			["restore", "Usage: agency restore"],
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
			{ name: "agents", state: "managed" },
			{ name: "opencode", state: "managed" },
		])

		const synced = parseJson(
			await runCli(["integration", "sync", "--json"], root),
		)
		expect(synced.files).toMatchObject([
			{ name: "agents", state: "managed", changed: false },
			{ name: "opencode", state: "managed", changed: false },
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
		const nextByCwd = parseJson(
			await runCli(
				["next", "--cwd", root, "--select", "--json"],
				projectRoot,
				env,
			),
		)
		expect(nextByCwd.selected.key).toBe("task/explicit")
		const nextByRegistration = parseJson(
			await runCli(
				["next", "--workbase", "primary", "--select", "--json"],
				projectRoot,
				env,
			),
		)
		expect(nextByRegistration.selected.key).toBe("task/explicit")

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
			["remote", "add", "origin", source],
		]) {
			expect(Bun.spawnSync(["git", "-C", source, ...args]).exitCode).toBe(0)
		}

		parseJson(await runCli(["init", root, "--json"], parent))
		await Bun.write(
			join(root, "agency.json"),
			JSON.stringify({
				version: 2,
				repositories: {
					agency: {
						remote: "https://example.com/agency-tests/source.git",
					},
				},
			}),
		)
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

		const listed = parseJson(await runCli(["worktree", "list", "--json"], root))
		expect(listed).toEqual([
			expect.objectContaining({
				owner: expect.objectContaining({ kind: "task", taskId: "example" }),
				checkouts: [
					expect.objectContaining({
						repo: "agency",
						kind: "writable",
						registered: true,
						actualBranch: "feat/example",
						actualCommit: expect.stringMatching(/^[0-9a-f]{40}$/),
						dirty: false,
					}),
				],
			}),
		])
		const rebuild = parseJson(
			await runCli(
				["worktree", "rebuild", "example", "--dry-run", "--json"],
				root,
			),
		)
		expect(rebuild).toMatchObject({
			operation: "rebuild",
			dryRun: true,
			actions: [
				`remove ${join(workbaseRoot, "tasks/example/code/agency")}`,
				`create ${join(workbaseRoot, "tasks/example/code/agency")}`,
			],
		})
		expect(
			await Bun.file(join(root, "tasks/example/code/agency/README.md")).text(),
		).toBe("example\n")
	})

	test.skipIf(Bun.which("opencode") === null)(
		"provides effective whole-workbase OpenCode access from every launch topology",
		async () => {
			const parent = await createTempDir()
			tempDirs.push(parent)
			const root = join(parent, "workbase")
			const source = join(parent, "source")
			expect(
				Bun.spawnSync(["git", "init", "--initial-branch=main", source])
					.exitCode,
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
			await runGit(["clone", "--bare", source, join(parent, "source.git")])
			const daemon = await startGitDaemon(parent)
			daemons.push(daemon.process)
			await runGit(["-C", source, "remote", "add", "origin", daemon.remote])

			parseJson(await runCli(["init", root, "--json"], parent))
			parseJson(
				await runCli(["repo", "link", "agency", source, "--json"], root),
			)
			parseJson(
				await runCli(
					[
						"epic",
						"create",
						"delivery",
						"--ticket-url",
						"https://example.com/delivery",
						"--repo",
						"agency:main",
						"--json",
					],
					root,
				),
			)
			for (const [id, branch] of [
				["example", "feat/example"],
				["sibling", "feat/sibling"],
			] as const) {
				parseJson(
					await runCli(
						[
							"task",
							"create",
							id,
							"--repo",
							"agency",
							"--branch",
							branch,
							"--base",
							"main",
							"--epic",
							"delivery",
							"--json",
						],
						root,
					),
				)
			}
			parseJson(
				await runCli(
					["task", "create", "pipeline", "--multi-phase", "--json"],
					root,
				),
			)
			parseJson(
				await runCli(
					[
						"phase",
						"create",
						"pipeline",
						"build",
						"--repo",
						"agency",
						"--branch",
						"feat/pipeline-build",
						"--base",
						"main",
						"--json",
					],
					root,
				),
			)

			const taskWorkspace = parseJson(
				await runCli(["work", "prepare", "example", "--json"], root),
			)
			const phaseWorkspace = parseJson(
				await runCli(
					[
						"work",
						"prepare",
						"--task",
						"pipeline",
						"--phase",
						"build",
						"--json",
					],
					root,
				),
			)
			const synced = parseJson(
				await runCli(["integration", "sync", "--json"], root),
			)
			expect(
				synced.files.every((file: { changed: boolean }) => !file.changed),
			).toBe(true)

			const workbaseRoot = await realpath(root)
			const config = await Bun.file(
				join(workbaseRoot, ".opencode/opencode.jsonc"),
			).text()
			expect(config).not.toContain(workbaseRoot)
			const documents = [
				join(workbaseRoot, "tasks/example/TASK.md"),
				join(workbaseRoot, "epics/delivery/EPIC.md"),
				join(workbaseRoot, "tasks/sibling/TASK.md"),
			]
			for (const document of documents) {
				expect(await Bun.file(document).exists()).toBe(true)
			}

			const launches = [
				{
					args: ["--task", "example"],
					cwd: join(workbaseRoot, "tasks/example"),
					writable: taskWorkspace.writablePath,
				},
				{
					args: ["--task", "pipeline", "--phase", "build"],
					cwd: join(workbaseRoot, "tasks/pipeline"),
					writable: phaseWorkspace.writablePath,
				},
				{
					args: ["--epic", "delivery"],
					cwd: join(workbaseRoot, "epics/delivery"),
					writable: null,
				},
				{
					args: ["--task", "pipeline"],
					cwd: join(workbaseRoot, "tasks/pipeline"),
					writable: null,
				},
			]
			for (const launch of launches) {
				const printed = await runCli(
					["work", ...launch.args, "--opencode", "--print-command", "--force"],
					root,
				)
				expect(printed.exitCode).toBe(0)
				expect(printed.stderr).toBe("")
				const contract = JSON.parse(printed.stdout)
				expect(contract.cwd).toBe(launch.cwd)
				expect(contract.environment.OPENCODE_CONFIG).toBe(
					join(workbaseRoot, ".opencode/opencode.jsonc"),
				)
				const environment = {
					...process.env,
					...contract.environment,
					XDG_CONFIG_HOME: isolatedConfigHome,
					OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
				}
				const probe = Bun.spawnSync(["opencode", "debug", "agent", "build"], {
					cwd: contract.cwd,
					env: environment,
				})
				expect(probe.exitCode).toBe(0)
				const agent = JSON.parse(probe.stdout.toString())
				expect(agent.permission).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							permission: "external_directory",
							pattern: join(workbaseRoot, "**"),
							action: "allow",
						}),
					]),
				)
				expect(agent.permission).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							permission: "edit",
							pattern: "*",
							action: "deny",
						}),
					]),
				)
				if (launch.writable) {
					expect(agent.permission).toEqual(
						expect.arrayContaining(
							[workbaseRoot, launch.cwd].map((base) =>
								expect.objectContaining({
									permission: "edit",
									pattern: join(relative(base, launch.writable!), "**"),
									action: "allow",
								}),
							),
						),
					)
				}

				if (launch === launches[0]) {
					for (const document of documents) {
						const read = Bun.spawnSync(
							[
								"opencode",
								"debug",
								"agent",
								"build",
								"--tool",
								"read",
								"--params",
								JSON.stringify({ filePath: document }),
							],
							{ cwd: contract.cwd, env: environment },
						)
						expect(read.exitCode).toBe(0)
						const result = JSON.parse(read.stdout.toString())
						expect(result.result.output).toContain(`<path>${document}</path>`)
					}
				}
			}
		},
		30_000,
	)

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
		await runGit([
			"-C",
			source,
			"remote",
			"add",
			"origin",
			"https://example.com/agency-tests/source.git",
		])

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
			"prepare",
			"implement",
			"release",
		])
		const phaseTable = await runCli(
			["phase", "list", "ship", "--repository", "agency", "--no-pr"],
			root,
		)
		expect(phaseTable.stdout).toMatch(
			/PHASE\s+PARENT\s+STATUS\s+READINESS\s+REPOSITORIES\s+BRANCH/,
		)
		expect(phaseTable.stdout.indexOf("prepare")).toBeLessThan(
			phaseTable.stdout.indexOf("implement"),
		)

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
		const doctor = parseJson(await runCli(["doctor", "--json"], root))
		expect(doctor).toMatchObject({
			version: 1,
			root: workbaseRoot,
			checks: expect.arrayContaining([
				expect.objectContaining({ id: "tool.git", status: "pass" }),
				expect.objectContaining({ id: "workbase.validation", status: "pass" }),
			]),
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

	test("restores portable repositories in a fresh workbase clone", async () => {
		const parent = await createTempDir()
		tempDirs.push(parent)
		const sourceWorktree = join(parent, "source-worktree")
		const source = join(parent, "source.git")
		const root = join(parent, "workbase")
		const restored = join(parent, "restored")

		await runGit(["init", "--initial-branch=main", sourceWorktree])
		await Bun.write(join(sourceWorktree, "README.md"), "portable\n")
		await runGit([
			"-C",
			sourceWorktree,
			"config",
			"user.email",
			"test@example.com",
		])
		await runGit(["-C", sourceWorktree, "config", "user.name", "Test"])
		await runGit(["-C", sourceWorktree, "add", "README.md"])
		await runGit([
			"-C",
			sourceWorktree,
			"-c",
			"commit.gpgsign=false",
			"commit",
			"-m",
			"initial",
		])
		await runGit(["clone", "--bare", sourceWorktree, source])
		const daemon = await startGitDaemon(parent)

		try {
			parseJson(await runCli(["init", root, "--json"], parent))
			parseJson(
				await runCli(["repo", "add", "agency", daemon.remote, "--json"], root),
			)
			parseJson(
				await runCli(
					[
						"task",
						"create",
						"portable",
						"--repo",
						"agency",
						"--branch",
						"feat/portable",
						"--base",
						"main",
						"--json",
					],
					root,
				),
			)

			await runGit(["init", "--initial-branch=main", root])
			await runGit(["-C", root, "config", "user.email", "test@example.com"])
			await runGit(["-C", root, "config", "user.name", "Test"])
			await runGit(["-C", root, "add", "."])
			await runGit([
				"-C",
				root,
				"-c",
				"commit.gpgsign=false",
				"commit",
				"-m",
				"portable workbase",
			])
			const tracked = await runGit(["-C", root, "ls-files"])
			expect(tracked).toContain("agency.json")
			expect(tracked).not.toContain("repos/agency")

			await runGit(["clone", root, restored])
			const planned = parseJson(
				await runCli(["repo", "setup", "--dry-run", "--json"], restored),
			)
			expect(planned.actions).toEqual([
				expect.objectContaining({
					alias: "agency",
					kind: "materialize",
					status: "planned",
				}),
			])
			expect(await Bun.file(join(restored, "repos/agency/HEAD")).exists()).toBe(
				false,
			)

			const applied = parseJson(
				await runCli(["repo", "setup", "--apply", "--json"], restored),
			)
			expect(applied.actions[0]).toMatchObject({
				alias: "agency",
				status: "applied",
			})
			expect(await Bun.file(join(restored, "repos/agency/HEAD")).exists()).toBe(
				true,
			)

			const prepared = parseJson(
				await runCli(["work", "prepare", "portable", "--json"], restored),
			)
			expect(prepared.checkouts).toEqual([
				expect.objectContaining({
					repo: "agency",
					action: "created",
				}),
			])
			expect(
				await Bun.file(
					join(restored, "tasks/portable/code/agency/README.md"),
				).text(),
			).toBe("portable\n")
		} finally {
			daemon.process.kill()
			await daemon.process.exited
		}
	}, 30_000)
})
