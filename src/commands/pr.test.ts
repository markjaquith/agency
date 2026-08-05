import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, realpath } from "node:fs/promises"
import { dirname, join } from "node:path"
import { cleanupTempDir, createTempDir, runTestEffect } from "../test-utils"
import { pr } from "./pr"

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

	const createExecutionWorkbase = async () => {
		const root = join(tempRoot, "workbase")
		await write(root, "agency.json", '{"version":2}\n')
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
		return root
	}

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
