import { afterEach, describe, expect, test } from "bun:test"
import { realpath } from "node:fs/promises"
import { join } from "node:path"
import { cleanupTempDir, createTempDir } from "./test-utils"

const projectRoot = join(import.meta.dir, "..")
const cliPath = join(projectRoot, "cli.ts")

interface CliResult {
	exitCode: number
	stdout: string
	stderr: string
}

async function runCli(args: string[], cwd = projectRoot): Promise<CliResult> {
	const subprocess = Bun.spawn([process.execPath, cliPath, ...args], {
		cwd,
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
	return JSON.parse(result.stdout)
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
			stdout: "v2.0.0\n",
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
		expect(unknown.stderr).toContain("Error: Unknown command 'unknown'")

		const cwd = await createTempDir()
		tempDirs.push(cwd)
		const taggedError = await runCli(["repo", "list"], cwd)
		expect(taggedError.exitCode).toBe(1)
		expect(taggedError.stdout).toBe("")
		expect(taggedError.stderr).toContain("ⓘ No Agency workbase found from")
		expect(taggedError.stderr).not.toContain("An error has occurred")
	})

	test("routes command help and global options on either side of commands", async () => {
		for (const [command, usage] of [
			["init", "Usage: agency init"],
			["repo", "Usage: agency repo"],
			["epic", "Usage: agency epic"],
			["task", "Usage: agency task"],
			["phase", "Usage: agency phase"],
			["work", "Usage: agency work"],
			["pr", "Usage: agency pr"],
			["status", "Usage: agency status"],
			["validate", "Usage: agency validate"],
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

		const validation = parseJson(await runCli(["validate", "--json"], root))
		expect(validation).toEqual({
			root: workbaseRoot,
			issues: [],
			epicCount: 1,
			taskCount: 1,
			phaseCount: 3,
			valid: true,
		})
	}, 30_000)
})
