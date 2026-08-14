import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { chmod, mkdir, realpath, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { PullRequestService } from "../services/PullRequestService"
import {
	captureLogs,
	cleanupTempDir,
	createTempDir,
	runTestEffect,
} from "../test-utils"
import { pr, prCreate } from "./pr"

const write = async (root: string, path: string, content: string) => {
	const fullPath = join(root, path)
	await mkdir(dirname(fullPath), { recursive: true })
	await Bun.write(fullPath, content)
}

describe("pr command", () => {
	let tempRoot: string
	let capturePath: string
	let originalPath: string | undefined

	beforeEach(async () => {
		tempRoot = await createTempDir()
		capturePath = join(tempRoot, "capture")
		const bin = join(tempRoot, "bin")
		await mkdir(bin)
		await Bun.write(
			join(bin, "gh"),
			`#!/bin/sh
printf '%s\n' "$PWD" "$@" > "$GH_CAPTURE"
if [ -n "$GIT_DIR" ]; then printf 'GIT_DIR=%s\n' "$GIT_DIR" >> "$GH_CAPTURE"; fi
exit "\${GH_EXIT:-0}"
`,
		)
		await chmod(join(bin, "gh"), 0o755)
		originalPath = process.env.PATH
		process.env.PATH = `${bin}:${originalPath ?? ""}`
		process.env.GH_CAPTURE = capturePath
	})

	afterEach(async () => {
		process.env.PATH = originalPath
		delete process.env.GH_CAPTURE
		delete process.env.GH_EXIT
		await cleanupTempDir(tempRoot)
	})

	const captured = async () =>
		(await Bun.file(capturePath).text()).trim().split("\n")

	const createExecutionWorkbase = async (vcs: "git" | "jj" = "git") => {
		const root = join(tempRoot, "workbase")
		await write(
			root,
			"agency.json",
			`${JSON.stringify({
				version: 2,
				vcs,
				repositories: {
					agency: { remote: "https://github.com/example/agency.git" },
				},
			})}\n`,
		)
		await mkdir(join(root, "repos/agency"), { recursive: true })
		await mkdir(join(root, "tasks/single/code/agency"), { recursive: true })
		await write(
			root,
			"tasks/single/TASK.md",
			`---
ticketUrl: null
repo: agency
branch: feat/single
base: main
pr: null
status: open
---

# Single
`,
		)
		await mkdir(join(root, "tasks/multi/phases/build/code/agency"), {
			recursive: true,
		})
		await write(
			root,
			"tasks/multi/TASK.md",
			`---
ticketUrl: null
phases:
  - id: build
---

# Multi
`,
		)
		await write(
			root,
			"tasks/multi/phases/build/PHASE.md",
			`---
repo: agency
branch: feat/build
base: main
pr: null
status: open
---

# Build
`,
		)
		if (vcs === "jj") {
			const repository = join(root, "repos/agency")
			await rm(join(root, "tasks/single/code/agency"), { recursive: true })
			await rm(join(root, "tasks/multi/phases/build/code/agency"), {
				recursive: true,
			})
			const initialized = Bun.spawn(
				["jj", "git", "init", "--no-colocate", repository],
				{ stdout: "pipe", stderr: "pipe" },
			)
			if ((await initialized.exited) !== 0)
				throw new Error(await new Response(initialized.stderr).text())
			for (const [name, path] of [
				["single", join(root, "tasks/single/code/agency")],
				["build", join(root, "tasks/multi/phases/build/code/agency")],
			] as const) {
				const workspace = Bun.spawn(
					[
						"jj",
						"-R",
						repository,
						"workspace",
						"add",
						"--name",
						name,
						"-r",
						"root()",
						path,
					],
					{ stdout: "pipe", stderr: "pipe" },
				)
				if ((await workspace.exited) !== 0)
					throw new Error(await new Response(workspace.stderr).text())
			}
		}
		return root
	}

	test("creates and records an Agency pull request", async () => {
		const url = "https://github.com/markjaquith/agency/pull/123"
		let received: unknown[] = []
		const logs = await captureLogs(() =>
			Effect.runPromise(
				prCreate({
					taskId: "example",
					phaseId: "implementation",
					draft: true,
					force: true,
					title: "Ship it",
					head: "task/example",
					base: "main",
					labels: ["ai-assisted"],
					cwd: "/workbase",
					json: true,
				}).pipe(
					Effect.provideService(PullRequestService, {
						create: (...args: unknown[]) => {
							received = args
							return Effect.succeed(url)
						},
					} as never),
				) as Effect.Effect<void, unknown, never>,
			),
		)

		expect(JSON.parse(logs[0]!)).toEqual({ url })
		expect(received).toEqual([
			"example",
			"implementation",
			true,
			"/workbase",
			expect.objectContaining({
				force: true,
				draft: true,
				title: "Ship it",
				head: "task/example",
				base: "main",
				labels: ["ai-assisted"],
				json: true,
			}),
		])
	})

	test("focuses task and descendant invocations on the writable checkout", async () => {
		const root = await createExecutionWorkbase()
		const task = join(root, "tasks/single")
		const descendant = join(task, "notes/deep")
		await mkdir(descendant, { recursive: true })

		for (const cwd of [task, descendant]) {
			expect(await runTestEffect(pr(["view"], cwd))).toBe(0)
			expect(await captured()).toEqual([
				await realpath(join(task, "code/agency")),
				"pr",
				"view",
			])
		}
	})

	test("focuses a phase invocation on its writable checkout", async () => {
		const root = await createExecutionWorkbase()
		const phase = join(root, "tasks/multi/phases/build")

		expect(await runTestEffect(pr(["status"], phase))).toBe(0)
		expect(await captured()).toEqual([
			await realpath(join(phase, "code/agency")),
			"pr",
			"status",
		])
	})

	test("injects the execution branch and repository for jj targets", async () => {
		const root = await createExecutionWorkbase("jj")
		const task = join(root, "tasks/single")
		const phase = join(root, "tasks/multi/phases/build")

		expect(await runTestEffect(pr(["view", "--web"], task))).toBe(0)
		expect(await captured()).toEqual([
			await realpath(join(task, "code/agency")),
			"pr",
			"view",
			"feat/single",
			"--repo",
			"example/agency",
			"--web",
			expect.stringMatching(/^GIT_DIR=.*\.jj/),
		])

		expect(
			await runTestEffect(pr(["create", "--title", "Example"], phase)),
		).toBe(0)
		expect(await captured()).toEqual([
			await realpath(join(phase, "code/agency")),
			"pr",
			"create",
			"--head",
			"feat/build",
			"--repo",
			"example/agency",
			"--title",
			"Example",
			expect.stringMatching(/^GIT_DIR=.*\.jj/),
		])
	})

	test("preserves explicit jj PR and repository targets", async () => {
		const root = await createExecutionWorkbase("jj")
		const task = join(root, "tasks/single")
		const args = ["view", "123", "--repo", "other/repository"]

		expect(await runTestEffect(pr(args, task))).toBe(0)
		expect(await captured()).toEqual([
			await realpath(join(task, "code/agency")),
			"pr",
			...args,
			expect.stringMatching(/^GIT_DIR=.*\.jj/),
		])
	})

	test("falls back to the invocation directory without execution authority", async () => {
		const root = await createExecutionWorkbase()
		const orchestration = join(root, "tasks/multi")
		const outside = join(tempRoot, "outside")
		await mkdir(outside)

		for (const cwd of [orchestration, outside]) {
			expect(await runTestEffect(pr(["list"], cwd))).toBe(0)
			expect(await captured()).toEqual([await realpath(cwd), "pr", "list"])
		}
	})

	test("forwards arguments unchanged and returns the gh exit code", async () => {
		const outside = join(tempRoot, "outside")
		await mkdir(outside)
		process.env.GH_EXIT = "23"
		const args = ["create", "--title", "two words", "--", "literal"]

		expect(await runTestEffect(pr(args, outside))).toBe(23)
		expect(await captured()).toEqual([await realpath(outside), "pr", ...args])
	})
})
