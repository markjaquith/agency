import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { cleanupTempDir, createTempDir, runTestEffect } from "../test-utils"
import { ReadinessService } from "./ReadinessService"

const write = async (root: string, path: string, content: string) => {
	const fullPath = join(root, path)
	await mkdir(dirname(fullPath), { recursive: true })
	await Bun.write(fullPath, content)
}

const execution = (status: string, branch: string) => `---
repo: agency
branch: ${branch}
base: main
pr: null
status: ${status}
---

# Execution
`

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
  - id: deploy
    dependsOn: [ship]
---

# Delivery
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
description: Ship the feature.
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
		execution("open", "feat/implement"),
	)
	await write(
		root,
		"tasks/ship/phases/verify/PHASE.md",
		execution("open", "feat/verify"),
	)
	await write(
		root,
		"tasks/abandoned/TASK.md",
		`---
ticketUrl: null
repo: agency
branch: feat/abandoned
base: main
pr: null
status: dropped
---

# Abandoned
`,
	)
	await write(
		root,
		"tasks/deploy/TASK.md",
		`---
ticketUrl: null
epic: delivery
repo: agency
branch: feat/deploy
base: main
pr: null
status: open
---

# Deploy
`,
	)
	return root
}

const service = <A>(
	run: (readiness: ReadinessService) => Effect.Effect<A, unknown, any>,
) => runTestEffect(ReadinessService.pipe(Effect.flatMap(run)))

describe("ReadinessService", () => {
	const roots: string[] = []

	afterEach(async () => {
		await Promise.all(roots.splice(0).map(cleanupTempDir))
	})

	test("ranks ready work and explains every excluded execution unit", async () => {
		const root = await createWorkbase()
		roots.push(root)

		const result = await service((readiness) => readiness.getNext(root, true))

		expect(result.ready.map((item) => item.key)).toEqual([
			"phase/ship/implement",
		])
		expect(result.selected).toMatchObject({
			key: "phase/ship/implement",
			parent: { epicId: "delivery", taskId: "ship" },
			priority: { dependentCount: 1 },
		})
		expect(result.excluded.map((item) => item.key)).toEqual([
			"task/prepare",
			"phase/ship/verify",
			"task/abandoned",
			"task/deploy",
		])
		expect(
			result.excluded.find((item) => item.key === "phase/ship/verify"),
		).toMatchObject({
			ready: false,
			terminal: false,
			blockedBy: ["phase:ship/implement"],
			blockers: [
				{
					kind: "dependency",
					status: "open",
					reason: "Phase dependency is open",
				},
			],
		})
		expect(
			result.excluded.find((item) => item.key === "task/abandoned"),
		).toMatchObject({ status: "dropped", terminal: true })
	})

	test("includes cross-task unlocks in final-phase priority", async () => {
		const root = await createWorkbase()
		roots.push(root)
		await Bun.write(
			join(root, "tasks/ship/phases/implement/PHASE.md"),
			execution("done", "feat/implement"),
		)

		const result = await service((readiness) => readiness.getNext(root, true))

		expect(result.selected).toMatchObject({
			key: "phase/ship/verify",
			priority: { dependentCount: 1 },
		})
	})

	test("uses the same readiness for work and PR guards", async () => {
		const root = await createWorkbase()
		roots.push(root)

		await service((readiness) =>
			readiness.guard("work", "ship", "implement", root),
		)
		await expect(
			service((readiness) => readiness.guard("work", "ship", "verify", root)),
		).rejects.toThrow("Phase dependency is open")
		await expect(
			service((readiness) => readiness.guard("pr", "ship", "verify", root)),
		).rejects.toThrow("Phase dependency is open")
		await service((readiness) =>
			readiness.guard("work", "ship", "verify", root, true),
		)
	})

	test("allows active PR targets but rejects terminal outcomes", async () => {
		const root = await createWorkbase()
		roots.push(root)
		const path = join(root, "tasks/ship/phases/implement/PHASE.md")
		await Bun.write(path, execution("working", "feat/implement"))

		await service((readiness) =>
			readiness.guard("pr", "ship", "implement", root),
		)

		await Bun.write(path, execution("done", "feat/implement"))
		await expect(
			service((readiness) => readiness.guard("pr", "ship", "implement", root)),
		).rejects.toThrow("Phase status is done")
	})
})
