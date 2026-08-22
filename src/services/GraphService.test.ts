import { afterEach, describe, expect, test } from "bun:test"
import { Schema } from "@effect/schema"
import { Effect } from "effect"
import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { AgencyGraph } from "../graph-schema"
import { cleanupTempDir, createTempDir, runTestEffect } from "../test-utils"
import { GraphService } from "./GraphService"
import {
	VersionControlService,
	type VersionControlBackend,
} from "./VersionControlService"

const write = async (root: string, path: string, content: string) => {
	const fullPath = join(root, path)
	await mkdir(dirname(fullPath), { recursive: true })
	await Bun.write(fullPath, content)
}

const createWorkbase = async () => {
	const root = await createTempDir()
	await write(root, "agency.json", '{"version":2}\n')
	await mkdir(join(root, "repos/agency"), { recursive: true })
	await write(
		root,
		"epics/delivery/EPIC.md",
		`---
ticketUrl: https://example.com/delivery
repos:
  - repo: agency
    ref: main
tasks:
  - id: prepare
  - id: ship
    dependsOn: [prepare]
---

# Delivery
Deliver the graph.
`,
	)
	await write(
		root,
		"tasks/prepare/TASK.md",
		`---
ticketUrl: null
epic: delivery
repo: agency
branch: feat/prepare
base: main
pr: null
status: done
---

# Prepare
`,
	)
	await write(
		root,
		"tasks/ship/TASK.md",
		`---
ticketUrl: null
epic: delivery
phases:
  - id: implement
  - id: verify
    dependsOn: [implement]
---

# Ship
`,
	)
	await write(
		root,
		"tasks/ship/phases/implement/PHASE.md",
		`---
repo: agency
branch: feat/implement
base: main
pr: null
status: open
---

# Implement
`,
	)
	await write(
		root,
		"tasks/ship/phases/verify/PHASE.md",
		`---
repo: agency
branch: feat/verify
base: main
pr: null
status: open
---

# Verify
`,
	)
	return root
}

const getGraph = (root: string, options: Record<string, unknown> = {}) =>
	runTestEffect(
		GraphService.pipe(
			Effect.flatMap((service) => service.get({ cwd: root, ...options })),
		),
	)

describe("GraphService", () => {
	const roots: string[] = []

	afterEach(async () => {
		await Promise.all(roots.splice(0).map(cleanupTempDir))
	})

	test("exports deterministic nodes, typed edges, and computed state", async () => {
		const root = await createWorkbase()
		roots.push(root)
		const graph = await getGraph(root)

		expect(Schema.decodeUnknownSync(AgencyGraph)(graph)).toEqual(graph)
		expect(graph.workbase.vcs).toBe("git")
		expect(graph.nodes.map((node) => node.id)).toEqual([
			"epic:delivery",
			"execution-unit:phase/ship/implement",
			"execution-unit:phase/ship/verify",
			"execution-unit:task/prepare",
			"phase:ship/implement",
			"phase:ship/verify",
			"repository:agency",
			"task:prepare",
			"task:ship",
		])
		expect(graph.edges).toContainEqual({
			id: "depends_on:task:ship->task:prepare",
			kind: "depends_on",
			from: "task:ship",
			to: "task:prepare",
		})
		expect(graph.edges).toContainEqual({
			id: "owns:phase:ship/verify->execution-unit:phase/ship/verify",
			kind: "owns",
			from: "phase:ship/verify",
			to: "execution-unit:phase/ship/verify",
		})
		expect(graph.edges).toContainEqual({
			id: "writes:execution-unit:task/prepare->repository:agency",
			kind: "writes",
			from: "execution-unit:task/prepare",
			to: "repository:agency",
		})

		const prepare = graph.nodes.find((node) => node.id === "task:prepare")!
		const ship = graph.nodes.find((node) => node.id === "task:ship")!
		const implement = graph.nodes.find(
			(node) => node.id === "phase:ship/implement",
		)!
		const verify = graph.nodes.find((node) => node.id === "phase:ship/verify")!
		expect(prepare.dependents).toEqual(["task:ship"])
		expect(prepare.readiness).toMatchObject({
			ready: false,
			terminal: true,
		})
		expect(ship.readiness).toMatchObject({
			ready: true,
			blocked: false,
			terminal: false,
		})
		expect(ship.aggregate).toMatchObject({ total: 2, open: 2, terminal: 0 })
		expect(implement.dependents).toEqual(["phase:ship/verify"])
		expect(implement.readiness).toMatchObject({ ready: true, blocked: false })
		expect(
			graph.nodes.find(
				(node) => node.id === "execution-unit:phase/ship/implement",
			)?.readiness,
		).toMatchObject({
			ready: true,
			blocked: false,
			blockedBy: [],
			terminal: false,
		})
		expect(verify.readiness).toMatchObject({
			ready: false,
			blocked: true,
			blockedBy: ["phase:ship/implement"],
			terminal: false,
			blockers: [
				{
					kind: "dependency",
					id: "phase:ship/implement",
					status: "open",
				},
			],
		})
		const epic = graph.nodes.find((node) => node.id === "epic:delivery")!
		expect(epic.aggregate).toMatchObject({ total: 3, done: 1, open: 2 })
		expect(graph.summary).toEqual({
			status: "open",
			total: 3,
			open: 2,
			working: 0,
			delegated: 0,
			done: 1,
			dropped: 0,
			terminal: 1,
		})
		expect(await getGraph(root)).toEqual(graph)
	})

	test("does not resolve a VCS backend when git details are not requested", async () => {
		const root = await createWorkbase()
		roots.push(root)
		let calls = 0
		const graph = await runTestEffect(
			GraphService.pipe(
				Effect.flatMap((service) => service.get({ cwd: root })),
				Effect.provideService(VersionControlService, {
					_tag: "VersionControlService",
					forWorkbase: () => {
						calls += 1
						throw new Error("unexpected VCS lookup")
					},
				}),
			),
		)

		expect(graph.nodes.length).toBeGreaterThan(0)
		expect(calls).toBe(0)
	})

	test("never reports claimed or terminal execution units as ready", async () => {
		const root = await createWorkbase()
		roots.push(root)
		const path = "tasks/ship/phases/implement/PHASE.md"

		for (const status of ["working", "delegated", "done", "dropped"]) {
			await write(
				root,
				path,
				`---
repo: agency
branch: feat/implement
base: main
pr: null
status: ${status}
---

# Implement
`,
			)
			const graph = await getGraph(root, {
				kinds: ["execution-unit"],
				ready: true,
			})
			expect(graph.nodes.map((node) => node.key)).not.toContain(
				"phase/ship/implement",
			)
		}
	})

	test("applies filters after computing graph state", async () => {
		const root = await createWorkbase()
		roots.push(root)

		const ready = await getGraph(root, {
			ready: true,
			kinds: ["execution-unit"],
			repositories: ["agency"],
			statuses: ["open"],
		})
		expect(ready.nodes.map((node) => node.id)).toEqual([
			"execution-unit:phase/ship/implement",
		])
		expect(ready.edges).toEqual([])

		const blocked = await getGraph(root, { blocked: true, kinds: ["phase"] })
		expect(blocked.nodes.map((node) => node.id)).toEqual(["phase:ship/verify"])
	})

	test("does not report structurally invalid phases as ready", async () => {
		const root = await createWorkbase()
		roots.push(root)
		await write(
			root,
			"tasks/ship/phases/orphan/PHASE.md",
			`---
repo: agency
branch: feat/orphan
base: main
pr: null
status: open
---

# Orphan
`,
		)

		const graph = await getGraph(root, { kinds: ["phase"], ready: true })
		expect(graph.nodes.map((node) => node.id)).not.toContain(
			"phase:ship/orphan",
		)
		const complete = await getGraph(root)
		expect(
			complete.nodes.find((node) => node.id === "phase:ship/orphan")?.readiness,
		).toMatchObject({
			ready: false,
			blocked: true,
			blockers: [
				{
					kind: "validation",
					id: "tasks/ship/TASK.md",
					reason: "Unlisted phase 'orphan'",
				},
			],
			blockedBy: ["tasks/ship/TASK.md"],
		})
	})

	test("inherits parent epic validation blockers", async () => {
		const root = await createWorkbase()
		roots.push(root)
		await write(
			root,
			"tasks/unlisted/TASK.md",
			`---
ticketUrl: null
epic: delivery
repo: agency
branch: feat/unlisted
base: main
pr: null
status: open
---

# Unlisted
`,
		)

		const graph = await getGraph(root)
		const execution = graph.nodes.find(
			(node) => node.id === "execution-unit:task/unlisted",
		)

		expect(execution?.readiness).toMatchObject({
			ready: false,
			blockers: [
				{
					kind: "validation",
					reason: "Epic does not list child task 'unlisted'",
				},
			],
		})
	})

	test("adds body, workspace, git, and PR details only when requested", async () => {
		const root = await createWorkbase()
		roots.push(root)
		const baseline = await getGraph(root)
		for (const node of baseline.nodes) {
			expect("body" in node).toBe(false)
			expect("workspace" in node).toBe(false)
			expect("git" in node).toBe(false)
			expect("pr" in node).toBe(false)
		}
		expect(baseline.workbase.root).toBeUndefined()

		const detailed = await getGraph(root, {
			include: ["bodies", "workspace", "git", "pr"],
			backend: {
				kind: "git",
				inspectRepository: () => Effect.succeed(null),
				listWorkspaces: () => Effect.succeed([]),
				resolveRevision: () => Effect.succeed(null),
				workspaceHead: () => Effect.succeed(null),
				workspaceDirty: () => Effect.succeed(null),
				remoteUrl: () => Effect.succeed(null),
			} as unknown as VersionControlBackend,
		})
		expect(detailed.includes).toEqual(["bodies", "git", "pr", "workspace"])
		expect(detailed.workbase.root).toBe(root)
		const epic = detailed.nodes.find((node) => node.id === "epic:delivery")
		const repository = detailed.nodes.find(
			(node) => node.id === "repository:agency",
		)
		const execution = detailed.nodes.find(
			(node) => node.id === "execution-unit:phase/ship/implement",
		)
		if (epic?.kind !== "epic") throw new Error("Missing epic node")
		if (repository?.kind !== "repository") {
			throw new Error("Missing repository node")
		}
		if (execution?.kind !== "execution-unit") {
			throw new Error("Missing execution-unit node")
		}
		expect(epic?.body).toContain("Deliver the graph")
		expect(repository?.git).toMatchObject({ kind: null })
		expect(execution?.pr).toEqual({ url: null, state: "none" })
		expect(Schema.decodeUnknownSync(AgencyGraph)(detailed)).toEqual(detailed)
	})

	test("reuses repository metadata and revision lookups for git details", async () => {
		const root = await createWorkbase()
		roots.push(root)
		const calls = {
			listWorkspaces: 0,
			remoteUrl: 0,
			resolveRevision: new Map<string, number>(),
		}
		const backend = {
			kind: "git",
			inspectRepository: () => Effect.succeed(null),
			listWorkspaces: () =>
				Effect.sync(() => {
					calls.listWorkspaces += 1
					return []
				}),
			remoteUrl: () =>
				Effect.sync(() => {
					calls.remoteUrl += 1
					return null
				}),
			resolveRevision: (_path: string, revision: string) =>
				Effect.sync(() => {
					calls.resolveRevision.set(
						revision,
						(calls.resolveRevision.get(revision) ?? 0) + 1,
					)
					return revision
				}),
			workspaceHead: () => Effect.succeed(null),
			workspaceDirty: () => Effect.succeed(null),
		} as unknown as VersionControlBackend

		await getGraph(root, { include: ["git"], backend })

		expect(calls.listWorkspaces).toBe(0)
		expect(calls.remoteUrl).toBe(1)
		expect(calls.resolveRevision).toEqual(
			new Map([
				["feat/prepare", 1],
				["feat/implement", 1],
				["feat/verify", 1],
				["main", 1],
			]),
		)
	})
})
