import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmod, mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import {
	captureLogs,
	cleanupTempDir,
	createTempDir,
	runTestEffect,
} from "../test-utils"
import { doctor } from "./doctor"

const write = async (root: string, path: string, content: string) => {
	const fullPath = join(root, path)
	await mkdir(dirname(fullPath), { recursive: true })
	await Bun.write(fullPath, content)
}

const managedAgents = (body: string) =>
	`<!-- agency-managed: sha256=${createHash("sha256").update(body).digest("hex")} -->\n\n${body}`

describe("doctor command", () => {
	let root: string
	let repository: string

	beforeEach(async () => {
		root = await createTempDir()
		repository = join(root, "source")
		await mkdir(repository)
		await Bun.$`git init -q -b main ${repository}`
		await Bun.$`git -C ${repository} config user.email test@example.com`
		await Bun.$`git -C ${repository} config user.name Test`
		await write(repository, "README.md", "test\n")
		await Bun.$`git -C ${repository} add README.md`
		await Bun.$`git -C ${repository} commit -q -m initial`
		await Bun.$`git -C ${repository} remote add origin https://example.com/agency.git`
		await write(
			root,
			"agency.json",
			JSON.stringify({
				version: 2,
				runners: {
					missing: {
						command: ["definitely-not-installed"],
						autoCommand: ["also-not-installed", "{prompt}"],
					},
				},
			}),
		)
		await mkdir(join(root, "repos"), { recursive: true })
		await Bun.$`ln -s ${repository} ${join(root, "repos/agency")}`
		await write(
			root,
			"tasks/example/TASK.md",
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
	})

	afterEach(async () => cleanupTempDir(root))

	test("returns stable checks, severities, and remediation in JSON", async () => {
		const logs = await captureLogs(() =>
			runTestEffect(doctor({ cwd: root, json: true })),
		)
		const report = JSON.parse(logs[0]!)

		expect(report).toMatchObject({
			version: 1,
			root,
			healthy: false,
		})
		expect(report.checks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "tool.git",
					level: "error",
					status: "pass",
				}),
				expect.objectContaining({
					id: "integration.runner.missing",
					level: "error",
					status: "fail",
				}),
				expect.objectContaining({
					id: "integration.runner.missing.auto",
					level: "error",
					status: "fail",
				}),
				expect.objectContaining({
					id: "ref.agency.main",
					status: "pass",
				}),
				expect.objectContaining({
					id: "worktree.task.example",
					status: "pass",
				}),
			]),
		)
		for (const check of report.checks) {
			if (check.status === "fail") expect(check.remediation).toBeTruthy()
		}
	})

	test("reports repository, ref, remote, and managed-file failures", async () => {
		await Bun.$`git -C ${repository} remote remove origin`
		await Bun.$`git -C ${repository} branch -m other`
		await write(root, "AGENTS.md", managedAgents("old\n"))

		const logs = await captureLogs(() =>
			runTestEffect(doctor({ cwd: root, json: true })),
		)
		const checks = JSON.parse(logs[0]!).checks

		expect(checks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "repository.agency.remote",
					status: "fail",
				}),
				expect.objectContaining({
					id: "ref.agency.main",
					status: "fail",
				}),
				expect.objectContaining({
					id: "integration.file.agents",
					status: "fail",
				}),
			]),
		)
	})

	test("warns when customized OpenCode config cannot guarantee access", async () => {
		const custom = '{"references":{}}\n'
		await write(root, ".opencode/opencode.jsonc", custom)

		const logs = await captureLogs(() =>
			runTestEffect(doctor({ cwd: root, json: true })),
		)
		const check = JSON.parse(logs[0]!).checks.find(
			(value: { id: string }) => value.id === "integration.file.opencode",
		)

		expect(check).toMatchObject({
			level: "warning",
			status: "fail",
			message: expect.stringContaining("cannot guarantee whole-workbase"),
			remediation: expect.stringContaining("global config"),
		})
		expect(await Bun.file(join(root, ".opencode/opencode.jsonc")).text()).toBe(
			custom,
		)
	})

	test("is safe when the workbase is read-only", async () => {
		for (const path of [
			join(root, "agency.json"),
			join(root, "tasks/example/TASK.md"),
		]) {
			await chmod(path, 0o444)
		}
		await chmod(join(root, "tasks/example"), 0o555)
		await chmod(join(root, "tasks"), 0o555)
		await chmod(root, 0o555)

		try {
			await runTestEffect(doctor({ cwd: root, silent: true }))
		} finally {
			await chmod(root, 0o755)
			await chmod(join(root, "tasks"), 0o755)
			await chmod(join(root, "tasks/example"), 0o755)
		}

		expect(await Bun.file(join(root, "AGENTS.md")).exists()).toBe(false)
		expect(
			await Bun.file(join(root, ".opencode/opencode.jsonc")).exists(),
		).toBe(false)
	})
})
