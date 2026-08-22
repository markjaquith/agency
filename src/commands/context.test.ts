import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdir, readFile as nodeReadFile, rename, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import {
	captureLogs,
	cleanupTempDir,
	createTempDir,
	runTestEffect,
} from "../test-utils"
import { context } from "./context"

const write = async (root: string, path: string, content: string) => {
	const fullPath = join(root, path)
	await mkdir(dirname(fullPath), { recursive: true })
	await Bun.write(fullPath, content)
}

const run = async (cwd: string, args: string[]) => {
	const process = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" })
	const [exitCode, stderr] = await Promise.all([
		process.exited,
		new Response(process.stderr).text(),
	])
	if (exitCode !== 0) throw new Error(`${args.join(" ")}: ${stderr}`)
}

const readContext = async (
	root: string,
	target: string | undefined,
	compact = false,
	full = false,
) => {
	const logs = await captureLogs(() =>
		runTestEffect(context({ cwd: root, target, compact, full, json: true })),
	)
	expect(logs).toHaveLength(1)
	return JSON.parse(logs[0]!)
}

describe("context", () => {
	let root: string

	beforeEach(async () => {
		root = await createTempDir()
		await write(root, "agency.json", '{"version":2}\n')
		for (const repo of ["agency", "docs"]) {
			const path = join(root, "repos", repo)
			await mkdir(path, { recursive: true })
			await run(root, ["git", "init", "--initial-branch=main", path])
			await run(path, ["git", "config", "user.email", "test@example.com"])
			await run(path, ["git", "config", "user.name", "Test"])
			await Bun.write(join(path, "README.md"), `${repo}\n`)
			await run(path, ["git", "add", "README.md"])
			await run(path, ["git", "commit", "-m", "initial"])
		}

		await write(
			root,
			"epics/contract/EPIC.md",
			`---
ticketUrl: https://example.com/contract
repos:
  - repo: agency
    ref: main
tasks:
  - id: foundations
  - id: agent-contract
    dependsOn: [foundations]
---

# Contract
`,
		)
		await write(
			root,
			"tasks/foundations/TASK.md",
			`---
ticketUrl: null
epic: contract
repo: agency
branch: foundations
base: main
pr: https://github.com/example/agency/pull/1
status: done
---

# Foundations
`,
		)
		await write(
			root,
			"tasks/agent-contract/TASK.md",
			`---
ticketUrl: null
epic: contract
phases:
  - id: schema
  - id: context-command
    dependsOn: [schema]
---

# Agent contract
Task prose.
`,
		)
		await write(
			root,
			"tasks/agent-contract/phases/schema/PHASE.md",
			`---
repo: agency
branch: schema
base: main
pr: https://github.com/example/agency/pull/2
status: done
---

# Schema
`,
		)
		await write(
			root,
			"tasks/agent-contract/phases/context-command/PHASE.md",
			`---
repo: agency
repos:
  - repo: docs
    ref: main
branch: feat/context
base: main
pr: null
status: open
---

# Context command
Phase prose.
`,
		)

		const code = join(root, "tasks/agent-contract/phases/context-command/code")
		await mkdir(code, { recursive: true })
		await run(join(root, "repos/agency"), [
			"git",
			"worktree",
			"add",
			"-b",
			"feat/context",
			join(code, "agency"),
			"main",
		])
		await run(join(root, "repos/docs"), [
			"git",
			"worktree",
			"add",
			"--detach",
			join(code, "docs"),
			"main",
		])
	})

	afterEach(async () => {
		await cleanupTempDir(root)
	})

	test("returns full phase context with graph, authority, Git, and validation state", async () => {
		const target = "tasks/agent-contract/phases/context-command"
		const result = await readContext(root, target, false, true)

		expect(result).toMatchObject({
			projection: "complete",
			workbase: { root, version: 2 },
			target: {
				kind: "phase",
				taskId: "agent-contract",
				phaseId: "context-command",
			},
			graph: {
				parent: { kind: "task", id: "agent-contract" },
				dependencies: ["schema"],
				readiness: { ready: true, blocked: false, blockers: [] },
				aggregate: { status: "open", total: 1, open: 1 },
			},
			authority: {
				mode: "execution",
				writable: { repo: "agency", branch: "feat/context", base: "main" },
				references: [{ repo: "docs", ref: "main" }],
			},
			workspace: {
				materialization: "complete",
				writable: {
					materialized: true,
					registered: true,
					checkoutBranch: "feat/context",
					detached: false,
				},
				references: [
					{
						repo: "docs",
						materialized: true,
						registered: true,
						detached: true,
					},
				],
			},
			pr: { url: null, state: "none" },
			validation: { valid: true, warnings: [] },
		})
		expect(result.documents.epic.body).toContain("# Contract")
		expect(result.documents.task.body).toContain("Task prose.")
		expect(result.documents.phase.body).toContain("Phase prose.")
		expect(result.documents.phase.sha256).toMatch(/^[a-f0-9]{64}$/)
		expect(result.authority.documents.writable).toEqual([
			join(root, "tasks/agent-contract/TASK.md"),
			join(root, "tasks/agent-contract/phases/context-command/PHASE.md"),
		])
		expect(result.workspace.writable.branchCommit).toMatch(/^[a-f0-9]{40}$/)
		expect(result.workspace.writable.baseCommit).toMatch(/^[a-f0-9]{40}$/)
		expect(result.workspace.references[0].resolvedCommit).toMatch(
			/^[a-f0-9]{40}$/,
		)
	})

	test("defaults to compact while preserving explicit compact compatibility", async () => {
		const result = await readContext(
			root,
			"tasks/agent-contract/phases/context-command/code/agency",
		)
		const explicit = await readContext(
			root,
			"tasks/agent-contract/phases/context-command/code/agency",
			true,
		)

		expect(result.projection).toBe("compact")
		expect(explicit).toEqual(result)
		expect(result.target.kind).toBe("phase")
		expect(result.documents.phase.body).toBeUndefined()
		expect(result.documents.phase.data.branch).toBe("feat/context")
		expect(result.documents.phase.sha256).toMatch(/^[a-f0-9]{64}$/)
		expect(result.workspace.writable).toEqual({
			materialized: true,
			registered: true,
		})
		expect(result.authority.writable.checkoutPath).toContain("code/agency")
		expect(result.authority.documents.writable).toEqual([
			join(root, "tasks/agent-contract/TASK.md"),
			join(root, "tasks/agent-contract/phases/context-command/PHASE.md"),
		])
	})

	test("reports dependency and validation blockers deterministically", async () => {
		await write(
			root,
			"tasks/agent-contract/phases/schema/PHASE.md",
			`---
repo: missing
branch: schema
base: main
pr: null
status: dropped
---

# Schema
`,
		)
		const result = await readContext(
			root,
			"tasks/agent-contract/phases/context-command",
		)

		expect(result.graph.readiness.ready).toBe(false)
		expect(result.graph.readiness.blockers).toContainEqual({
			kind: "dependency",
			id: "schema",
			status: "dropped",
			reason: "Phase dependency is dropped",
		})
		expect(result.validation.valid).toBe(false)
		expect(result.validation.warnings).toContainEqual({
			path: "tasks/agent-contract/phases/schema/PHASE.md",
			message: "Unknown repository alias 'missing'",
		})
	})

	test("reads each workbase document at most once per invocation", async () => {
		const reads = new Map<string, number>()
		const originalFile = Bun.file
		Bun.file = mock((path: string) => {
			const file = originalFile(path)
			return Object.assign(file, {
				text: async () => {
					reads.set(path, (reads.get(path) ?? 0) + 1)
					return nodeReadFile(path, "utf8")
				},
			})
		}) as unknown as typeof Bun.file
		try {
			await readContext(root, "tasks/agent-contract/phases/context-command")
		} finally {
			Bun.file = originalFile
		}

		const documents = [...reads].filter(([path]) =>
			/(?:EPIC|TASK|PHASE)\.md$/.test(path),
		)
		expect(documents.length).toBeGreaterThan(0)
		expect(documents.every(([, count]) => count === 1)).toBe(true)
	})

	test("resolves a bare task ID and returns root discovery context", async () => {
		const task = await readContext(root, "agent-contract")
		expect(task.target).toMatchObject({
			kind: "task",
			taskId: "agent-contract",
		})
		expect(task.graph.parent).toEqual({ kind: "epic", id: "contract" })
		expect(task.authority.documents.writable).toEqual([])

		const executionTask = await readContext(root, "foundations")
		expect(executionTask.authority.documents.writable).toEqual([
			join(root, "tasks/foundations/TASK.md"),
		])

		const workbase = await readContext(root, ".")
		expect(workbase).toMatchObject({
			projection: "compact",
			workbase: { root, version: 2 },
			target: { kind: "workbase", path: root },
			hint: "Run agency context . --full --json to include document prose.",
			authority: {
				mode: "orchestration",
				writable: null,
				references: [],
			},
			validation: { valid: true, warnings: [] },
		})
		expect(
			workbase.discovery.epics.map((item: { id: string }) => item.id),
		).toEqual(["contract"])
		expect(
			workbase.discovery.tasks.map((item: { id: string }) => item.id),
		).toEqual(["agent-contract", "foundations"])
		expect(
			workbase.discovery.phases.map(
				(item: { taskId: string; id: string }) => `${item.taskId}/${item.id}`,
			),
		).toEqual(["agent-contract/context-command", "agent-contract/schema"])
		expect(workbase.discovery.tasks[0].body).toBeUndefined()
		expect(workbase.discovery.phases[0].data.status).toBe("open")
		expect(workbase.discovery.phases[0].sha256).toMatch(/^[a-f0-9]{64}$/)
	})

	test("includes discovery prose only in full root context", async () => {
		const workbase = await readContext(root, ".", false, true)
		expect(workbase.projection).toBe("complete")
		expect(workbase.hint).toBeNull()
		expect(workbase.discovery.epics[0].body).toContain("# Contract")
		expect(workbase.discovery.tasks[0].body).toContain("Task prose.")
		expect(workbase.discovery.tasks[0].data.phases).toBeDefined()
		expect(workbase.discovery.phases[0].taskId).toBe("agent-contract")
	})

	test("resolves bare task IDs from inside another target", async () => {
		const cwd = join(
			root,
			"tasks/agent-contract/phases/context-command/code/agency",
		)
		const logs = await captureLogs(() =>
			runTestEffect(context({ cwd, target: "foundations", json: true })),
		)
		const result = JSON.parse(logs[0]!)
		expect(result.target).toMatchObject({ kind: "task", taskId: "foundations" })
		expect(result.authority.writable.branch).toBe("foundations")
	})

	test("resolves archived tasks without granting mutation or execution authority", async () => {
		await mkdir(join(root, "archive/tasks"), { recursive: true })
		await rename(
			join(root, "tasks/foundations"),
			join(root, "archive/tasks/foundations"),
		)

		const result = await readContext(root, "foundations", false, true)

		expect(result.target).toMatchObject({
			kind: "task",
			taskId: "foundations",
			archived: true,
			path: join(root, "archive/tasks/foundations/TASK.md"),
		})
		expect(result.documents.task.body).toContain("# Foundations")
		expect(result.authority).toMatchObject({
			mode: "orchestration",
			writable: null,
			references: [],
			documents: { writable: [] },
		})
		expect(result.workspace).toMatchObject({
			materialization: "absent",
			writable: null,
			references: [],
		})
		expect(result.graph.readiness).toMatchObject({
			ready: false,
			blocked: true,
		})
		expect(result.graph.readiness.blockers).toContainEqual({
			kind: "status",
			id: "foundations",
			reason: "Target is archived; restore it before mutation or execution",
		})
		expect(result.pr).toMatchObject({
			url: "https://github.com/example/agency/pull/1",
			state: "open",
		})
	})

	test("resolves archived phases with their active parent context", async () => {
		await mkdir(join(root, "archive/tasks/agent-contract/phases"), {
			recursive: true,
		})
		await rename(
			join(root, "tasks/agent-contract/phases/context-command"),
			join(root, "archive/tasks/agent-contract/phases/context-command"),
		)

		const result = await readContext(
			root,
			"archive/tasks/agent-contract/phases/context-command",
			false,
			true,
		)

		expect(result.target).toMatchObject({
			kind: "phase",
			taskId: "agent-contract",
			phaseId: "context-command",
			archived: true,
			path: join(
				root,
				"archive/tasks/agent-contract/phases/context-command/PHASE.md",
			),
		})
		expect(result.documents.task.body).toContain("Task prose.")
		expect(result.documents.phase.body).toContain("Phase prose.")
		expect(result.graph.parent).toEqual({ kind: "task", id: "agent-contract" })
		expect(result.graph.readiness).toMatchObject({
			ready: false,
			blocked: true,
		})
		expect(result.authority).toMatchObject({
			mode: "orchestration",
			writable: null,
			references: [],
			documents: { writable: [] },
		})
	})

	test("resolves archived epics with archived descendant graph context", async () => {
		await mkdir(join(root, "archive/epics"), { recursive: true })
		await mkdir(join(root, "archive/tasks"), { recursive: true })
		await rename(
			join(root, "epics/contract"),
			join(root, "archive/epics/contract"),
		)
		for (const taskId of ["agent-contract", "foundations"]) {
			await rename(
				join(root, "tasks", taskId),
				join(root, "archive/tasks", taskId),
			)
		}

		const result = await readContext(root, "epics/contract", false, true)

		expect(result.target).toMatchObject({
			kind: "epic",
			epicId: "contract",
			archived: true,
			path: join(root, "archive/epics/contract/EPIC.md"),
		})
		expect(result.documents.epic.body).toContain("# Contract")
		expect(result.graph.aggregate).toMatchObject({ total: 3, done: 2, open: 1 })
		expect(result.graph.readiness).toMatchObject({
			ready: false,
			blocked: true,
		})
		expect(result.authority).toMatchObject({
			mode: "orchestration",
			writable: null,
			references: [],
			documents: { writable: [] },
		})
	})

	test("computes orchestration readiness from runnable descendants", async () => {
		await write(
			root,
			"tasks/agent-contract/TASK.md",
			`---
ticketUrl: null
epic: contract
phases:
  - id: schema
  - id: context-command
    dependsOn: [schema]
  - id: parallel
---

# Agent contract
`,
		)
		await write(
			root,
			"tasks/agent-contract/phases/schema/PHASE.md",
			`---
repo: agency
branch: schema
base: main
pr: null
status: working
---

# Schema
`,
		)
		await write(
			root,
			"tasks/agent-contract/phases/parallel/PHASE.md",
			`---
repo: docs
branch: parallel
base: main
pr: null
status: open
---

# Parallel
`,
		)

		const task = await readContext(root, "agent-contract")
		expect(task.graph.readiness).toMatchObject({ ready: true, blocked: false })
		expect(task.graph.aggregate).toMatchObject({
			status: "working",
			total: 3,
			open: 2,
			working: 1,
		})

		const epic = await readContext(root, "epics/contract")
		expect(epic.graph.readiness).toMatchObject({ ready: true, blocked: false })
		expect(epic.graph.aggregate).toMatchObject({
			status: "working",
			total: 4,
			done: 1,
			open: 2,
			working: 1,
		})
	})

	test("reports stale worktree registration independently of materialization", async () => {
		const checkout = join(
			root,
			"tasks/agent-contract/phases/context-command/code/agency",
		)
		await rm(checkout, { recursive: true, force: true })

		const result = await readContext(
			root,
			"tasks/agent-contract/phases/context-command",
		)
		expect(result.workspace.writable).toMatchObject({
			materialized: false,
			registered: true,
		})
		expect(result.workspace.materialization).toBe("partial")
	})
})
