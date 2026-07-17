import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { chmod, mkdir, realpath, rm } from "node:fs/promises"
import { join } from "node:path"
import { cleanupTempDir, createTempDir, runTestEffect } from "../test-utils"
import { PhaseService } from "./PhaseService"
import { TaskService } from "./TaskService"
import { PullRequestService } from "./PullRequestService"
import { WorktreeService } from "./WorktreeService"

interface CommandResult {
	readonly stdout: string
	readonly stderr: string
	readonly exitCode: number
}

const runCommand = async (
	args: readonly string[],
	cwd?: string,
): Promise<CommandResult> => {
	const process = Bun.spawn([...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	})
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
		process.exited,
	])
	return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode }
}

const requireCommand = async (args: readonly string[], cwd?: string) => {
	const result = await runCommand(args, cwd)
	if (result.exitCode !== 0) {
		throw new Error(`${args.join(" ")} failed: ${result.stderr}`)
	}
	return result
}

describe("PullRequestService", () => {
	let root: string
	let remotePath: string
	let ghCallPath: string
	let originalPath: string | undefined

	const createTask = (id = "example", branch = `task/${id}`) =>
		runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id,
							ticketUrl: "https://example.com/task",
							repo: "agency",
							branch,
							base: "main",
						},
						root,
					),
				),
			),
		)

	const createPullRequest = (
		taskId = "example",
		phaseId?: string,
		draft = false,
		force = false,
	) =>
		runTestEffect(
			PullRequestService.pipe(
				Effect.flatMap((service) =>
					service.create(taskId, phaseId, draft, root, { force }),
				),
			),
		)

	const materialize = (taskId = "example", phaseId?: string) =>
		runTestEffect(
			WorktreeService.pipe(
				Effect.flatMap((service) => service.materialize(taskId, phaseId, root)),
			),
		)

	const writeFakeGh = async ({
		stdout = "",
		stderr = "",
		exitCode = 0,
	}: {
		stdout?: string
		stderr?: string
		exitCode?: number
	}) => {
		const path = join(root, "bin", "gh")
		await Bun.write(
			path,
			`#!/usr/bin/env bun
await Bun.write(${JSON.stringify(ghCallPath)}, JSON.stringify({ args: Bun.argv.slice(2), cwd: process.cwd() }))
process.stdout.write(${JSON.stringify(stdout)})
process.stderr.write(${JSON.stringify(stderr)})
process.exit(${exitCode})
`,
		)
		await chmod(path, 0o755)
	}

	const readGhCall = async () =>
		(await Bun.file(ghCallPath).json()) as {
			args: string[]
			cwd: string
		}

	const expectRemoteBranch = async (branch: string, exists = true) => {
		const result = await runCommand([
			"git",
			"--git-dir",
			remotePath,
			"show-ref",
			"--verify",
			`refs/heads/${branch}`,
		])
		expect(result.exitCode === 0).toBe(exists)
	}

	beforeEach(async () => {
		root = await createTempDir()
		remotePath = join(root, "remote.git")
		ghCallPath = join(root, "gh-call.json")
		originalPath = process.env.PATH
		await mkdir(join(root, "bin"), { recursive: true })
		process.env.PATH = `${join(root, "bin")}:${originalPath ?? ""}`
		await Bun.write(join(root, "agency.json"), '{"version":2}\n')
		await mkdir(join(root, "repos"), { recursive: true })
		await requireCommand([
			"git",
			"init",
			"--bare",
			"--initial-branch=main",
			remotePath,
		])
		const seedPath = join(root, "seed")
		await requireCommand(["git", "init", "--initial-branch=main", seedPath])
		await requireCommand(
			["git", "config", "user.name", "Agency Test"],
			seedPath,
		)
		await requireCommand(
			["git", "config", "user.email", "agency@example.com"],
			seedPath,
		)
		await Bun.write(join(seedPath, "README.md"), "# Test repository\n")
		await requireCommand(["git", "add", "README.md"], seedPath)
		await requireCommand(["git", "commit", "-m", "Initial commit"], seedPath)
		await requireCommand(
			["git", "remote", "add", "origin", remotePath],
			seedPath,
		)
		await requireCommand(["git", "push", "-u", "origin", "main"], seedPath)
		await requireCommand([
			"git",
			"clone",
			"--bare",
			remotePath,
			join(root, "repos", "agency"),
		])
	})

	afterEach(async () => {
		process.env.PATH = originalPath
		await cleanupTempDir(root)
	})

	test("updates the execution document with a PR URL", async () => {
		await createTask()
		const url = "https://github.com/markjaquith/agency/pull/123"
		await runTestEffect(
			PullRequestService.pipe(
				Effect.flatMap((service) =>
					service.setUrl("example", undefined, url, root),
				),
			),
		)
		const task = await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) => service.show("example", root)),
			),
		)
		expect("pr" in task.data && task.data.pr).toMatchObject({
			provider: "github",
			repository: "markjaquith/agency",
			identifier: "123",
			url,
		})
	})

	test("rejects non-GitHub PR URLs", async () => {
		await createTask()
		await expect(
			runTestEffect(
				PullRequestService.pipe(
					Effect.flatMap((service) =>
						service.setUrl(
							"example",
							undefined,
							"https://example.com/pr/1",
							root,
						),
					),
				),
			),
		).rejects.toThrow("Invalid GitHub pull request URL")
	})

	test("creates a clean single-phase PR and preserves the task body", async () => {
		await createTask()
		const taskPath = join(root, "tasks", "example", "TASK.md")
		const body = "# Example\n\nKeep this exact body after creating the PR."
		const original = await Bun.file(taskPath).text()
		await Bun.write(
			taskPath,
			original.replace("# Example\n\nDescribe the task outcome.", body),
		)
		const url = "https://github.com/example/agency/pull/42"
		await writeFakeGh({ stdout: `${url}\n` })

		expect(await createPullRequest()).toBe(url)
		await expectRemoteBranch("task/example")
		const ghCall = await readGhCall()
		expect(ghCall).toEqual({
			args: ["pr", "create", "--fill", "--base", "main"],
			cwd: await realpath(join(root, "tasks", "example", "code", "agency")),
		})
		const updated = await Bun.file(taskPath).text()
		expect(updated).toContain("pr:\n  provider: github")
		expect(updated).toContain("url: https://github.com/example/agency/pull/42")
		expect(updated.endsWith(`${body}\n`)).toBe(true)
	})

	test("passes --draft to gh", async () => {
		await createTask()
		await writeFakeGh({
			stdout: "https://github.com/example/agency/pull/43\n",
		})

		await createPullRequest("example", undefined, true)

		expect((await readGhCall()).args).toEqual([
			"pr",
			"create",
			"--fill",
			"--base",
			"main",
			"--draft",
		])
	})

	test("guards terminal targets before materializing unless forced", async () => {
		await createTask()
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) => service.setStatus("example", "done", root)),
			),
		)

		await expect(createPullRequest()).rejects.toThrow("Task status is done")
		expect(
			await Bun.file(join(root, "tasks/example/code/agency")).exists(),
		).toBe(false)

		const url = "https://github.com/example/agency/pull/49"
		await writeFakeGh({ stdout: url })
		expect(await createPullRequest("example", undefined, false, true)).toBe(url)
	})

	test("updates only PHASE.md for a phase PR", async () => {
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "multi",
							ticketUrl: "https://example.com/task",
							multiPhase: true,
						},
						root,
					),
				),
			),
		)
		await runTestEffect(
			PhaseService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							taskId: "multi",
							id: "implementation",
							repo: "agency",
							branch: "task/multi-implementation",
							base: "main",
						},
						root,
					),
				),
			),
		)
		const taskPath = join(root, "tasks", "multi", "TASK.md")
		const phasePath = join(
			root,
			"tasks",
			"multi",
			"phases",
			"implementation",
			"PHASE.md",
		)
		const originalTask = await Bun.file(taskPath).text()
		const url = "https://github.com/example/agency/pull/44"
		await writeFakeGh({ stdout: url })

		await createPullRequest("multi", "implementation")

		expect(await Bun.file(taskPath).text()).toBe(originalTask)
		expect(await Bun.file(phasePath).text()).toContain(`url: ${url}`)
		await expectRemoteBranch("task/multi-implementation")
	})

	test("blocks a dirty checkout before push or gh", async () => {
		await createTask()
		const workspace = await materialize()
		await Bun.write(join(workspace.writablePath, "dirty.txt"), "dirty\n")
		await writeFakeGh({ stdout: "https://github.com/example/agency/pull/45" })

		await expect(createPullRequest()).rejects.toThrow(
			"Cannot create a PR with a dirty worktree",
		)

		await expectRemoteBranch("task/example", false)
		expect(await Bun.file(ghCallPath).exists()).toBe(false)
	})

	test("blocks PR creation when workbase validation fails", async () => {
		await createTask()
		await materialize()
		await mkdir(join(root, "tasks", "missing-document"), { recursive: true })
		await writeFakeGh({ stdout: "https://github.com/example/agency/pull/45" })

		await expect(createPullRequest()).rejects.toThrow(
			"Required document is missing",
		)

		await expectRemoteBranch("task/example", false)
		expect(await Bun.file(ghCallPath).exists()).toBe(false)
	})

	test("reports push failure and does not invoke gh", async () => {
		await createTask()
		await materialize()
		const hookPath = join(remotePath, "hooks", "pre-receive")
		await Bun.write(hookPath, "#!/bin/sh\necho push rejected >&2\nexit 1\n")
		await chmod(hookPath, 0o755)
		await writeFakeGh({ stdout: "https://github.com/example/agency/pull/46" })

		await expect(createPullRequest()).rejects.toThrow("Failed to push branch")

		await expectRemoteBranch("task/example", false)
		expect(await Bun.file(ghCallPath).exists()).toBe(false)
	})

	test("reports gh failure without persisting a URL", async () => {
		await createTask()
		await writeFakeGh({ stderr: "authentication failed\n", exitCode: 1 })

		await expect(createPullRequest()).rejects.toThrow(
			"Failed to create pull request: authentication failed",
		)

		const task = await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) => service.show("example", root)),
			),
		)
		expect("pr" in task.data && task.data.pr).toBeNull()
	})

	test("rejects successful gh output without a PR URL", async () => {
		await createTask()
		await writeFakeGh({ stdout: "Pull request created successfully\n" })

		await expect(createPullRequest()).rejects.toThrow(
			"GitHub CLI did not return a pull request URL",
		)
	})

	test("extracts a PR URL from noisy gh output", async () => {
		await createTask()
		const url = "https://github.com/example/agency/pull/47"
		await writeFakeGh({
			stdout: `Creating pull request...\n${url}\nView it in your browser.\n`,
		})

		expect(await createPullRequest()).toBe(url)

		const task = await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) => service.show("example", root)),
			),
		)
		expect("pr" in task.data && task.data.pr).toMatchObject({ url })
	})

	test("uses a configured remote and argv provider", async () => {
		await createTask()
		await requireCommand(
			["git", "remote", "rename", "origin", "upstream"],
			join(root, "repos", "agency"),
		)
		const callPath = join(root, "delivery-call.json")
		const providerRecord = {
			provider: "forge",
			repository: remotePath.replace(/\.git$/, ""),
			identifier: "17",
			url: "https://forge.example/example/agency/pulls/17",
			state: "open",
			draft: false,
			merged: false,
		} as const
		await Bun.write(
			join(root, "bin", "deliver"),
			`#!/usr/bin/env bun
await Bun.write(${JSON.stringify(callPath)}, JSON.stringify({ args: Bun.argv.slice(2), base: process.env.DELIVERY_BASE }))
process.stdout.write(${JSON.stringify(JSON.stringify(providerRecord))})
`,
		)
		await chmod(join(root, "bin", "deliver"), 0o755)
		await Bun.write(
			join(root, "agency.json"),
			JSON.stringify({
				version: 2,
				delivery: {
					provider: "forge",
					remote: "upstream",
					createCommand: ["deliver", "create", "{repository}", "{branch}"],
					queryCommand: ["deliver", "query", "{identifier}"],
					environment: { DELIVERY_BASE: "{base}" },
				},
			}),
		)

		expect(await createPullRequest()).toBe(providerRecord.url)
		expect(await Bun.file(callPath).json()).toEqual({
			args: ["create", remotePath.replace(/\.git$/, ""), "task/example"],
			base: "main",
		})
		const task = await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) => service.show("example", root)),
			),
		)
		expect("pr" in task.data && task.data.pr).toEqual(providerRecord)
	})

	test("does not persist malformed provider output", async () => {
		await createTask()
		await Bun.write(
			join(root, "bin", "deliver"),
			"#!/usr/bin/env bun\nprocess.stdout.write('{}')\n",
		)
		await chmod(join(root, "bin", "deliver"), 0o755)
		await Bun.write(
			join(root, "agency.json"),
			JSON.stringify({
				version: 2,
				delivery: {
					provider: "forge",
					createCommand: ["deliver", "create"],
					queryCommand: ["deliver", "query"],
				},
			}),
		)

		await expect(createPullRequest()).rejects.toThrow(
			"Delivery provider did not return a valid pull request record",
		)
		const task = await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) => service.show("example", root)),
			),
		)
		expect("pr" in task.data && task.data.pr).toBeNull()
	})

	test("reports git status failure before push or gh", async () => {
		await createTask()
		const workspace = await materialize()
		await rm(join(workspace.writablePath, ".git"))
		await writeFakeGh({ stdout: "https://github.com/example/agency/pull/48" })

		await expect(createPullRequest()).rejects.toThrow(
			"Failed to inspect worktree status",
		)

		await expectRemoteBranch("task/example", false)
		expect(await Bun.file(ghCallPath).exists()).toBe(false)
	})
})
