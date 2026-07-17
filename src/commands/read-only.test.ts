import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { chmod, lstat, mkdir, readdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { cleanupTempDir, createTempDir, runTestEffect } from "../test-utils"
import { WorkbaseService } from "../services/WorkbaseService"
import { epic } from "./epic"
import { integration } from "./integration"
import { phase } from "./phase"
import { repo } from "./repo"
import { status } from "./status"
import { task } from "./task"
import { validate } from "./validate"
import { context } from "./context"

const write = async (root: string, path: string, content: string) => {
	const fullPath = join(root, path)
	await mkdir(dirname(fullPath), { recursive: true })
	await Bun.write(fullPath, content)
}

const setReadOnly = async (path: string, readOnly: boolean): Promise<void> => {
	const metadata = await lstat(path)
	if (!metadata.isDirectory()) {
		await chmod(path, readOnly ? 0o444 : 0o644)
		return
	}

	if (!readOnly) await chmod(path, 0o755)
	for (const entry of await readdir(path)) {
		await setReadOnly(join(path, entry), readOnly)
	}
	if (readOnly) await chmod(path, 0o555)
}

describe("observational commands", () => {
	let root: string

	beforeEach(async () => {
		root = await createTempDir()
		await write(root, "agency.json", '{"version":2}\n')
		await mkdir(join(root, "repos/agency"), { recursive: true })
		await write(
			root,
			"epics/example/EPIC.md",
			`---
ticketUrl: https://example.com/epics/example
repos:
  - repo: agency
    ref: main
tasks:
  - id: example-task
---

# Example
`,
		)
		await write(
			root,
			"tasks/example-task/TASK.md",
			`---
ticketUrl: null
epic: example
phases:
  - id: implementation
---

# Example task
`,
		)
		await write(
			root,
			"tasks/example-task/phases/implementation/PHASE.md",
			`---
repo: agency
branch: feat/example
base: main
pr: null
status: open
---

# Implementation
`,
		)
	})

	afterEach(async () => {
		await setReadOnly(root, false)
		await cleanupTempDir(root)
	})

	test("remain usable when the workbase is read-only", async () => {
		await setReadOnly(root, true)

		await runTestEffect(
			WorkbaseService.pipe(Effect.flatMap((service) => service.discover(root))),
		)
		await runTestEffect(
			integration({ subcommand: "status", cwd: root, silent: true }),
		)
		await runTestEffect(
			epic({ subcommand: "list", args: [], cwd: root, silent: true }),
		)
		await runTestEffect(
			epic({ subcommand: "show", args: ["example"], cwd: root, silent: true }),
		)
		await runTestEffect(
			task({ subcommand: "list", args: [], cwd: root, silent: true }),
		)
		await runTestEffect(
			task({
				subcommand: "show",
				args: ["example-task"],
				cwd: root,
				silent: true,
			}),
		)
		await runTestEffect(
			phase({
				subcommand: "list",
				args: ["example-task"],
				cwd: root,
				silent: true,
			}),
		)
		await runTestEffect(
			phase({
				subcommand: "show",
				args: ["example-task", "implementation"],
				cwd: root,
				silent: true,
			}),
		)
		await runTestEffect(
			repo({ subcommand: "list", args: [], cwd: root, silent: true }),
		)
		await runTestEffect(status({ cwd: root, silent: true }))
		await runTestEffect(validate({ path: root, silent: true }))
		await runTestEffect(
			context({
				target: "tasks/example-task/phases/implementation",
				cwd: root,
				silent: true,
			}),
		)

		expect(await Bun.file(join(root, "AGENTS.md")).exists()).toBe(false)
		expect(
			await Bun.file(join(root, ".opencode/opencode.jsonc")).exists(),
		).toBe(false)
	})
})
