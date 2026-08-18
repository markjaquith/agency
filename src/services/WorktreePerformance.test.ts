import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { cleanupTempDir, createTempDir, runTestEffect } from "../test-utils"
import { PhaseService } from "./PhaseService"
import { TaskService } from "./TaskService"

const taskDocument = (id: string) => `---
ticketUrl: null
repo: agency
branch: task/${id}
base: main
pr: null
status: open
---

# ${id}
`

describe("worktree document loading", () => {
	let root: string

	beforeEach(async () => {
		root = await createTempDir()
		await Bun.write(join(root, "agency.json"), '{"version":2}\n')
	})

	afterEach(async () => cleanupTempDir(root))

	test("shows a task without parsing sibling task documents", async () => {
		await mkdir(join(root, "tasks/target"), { recursive: true })
		await mkdir(join(root, "tasks/broken"), { recursive: true })
		await Bun.write(join(root, "tasks/target/TASK.md"), taskDocument("target"))
		await Bun.write(join(root, "tasks/broken/TASK.md"), "invalid frontmatter")

		const task = await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) => service.show("target", root)),
			),
		)

		expect(task.id).toBe("target")
	})

	test("lists phases from a preloaded task without rereading its parent", async () => {
		const phasePath = join(root, "tasks/multi/phases/build")
		await mkdir(phasePath, { recursive: true })
		await Bun.write(
			join(phasePath, "PHASE.md"),
			`---
repo: agency
branch: task/multi-build
base: main
pr: null
status: open
---

# Build
`,
		)

		const phases = await runTestEffect(
			PhaseService.pipe(
				Effect.flatMap((service) => service.list("multi", root, true)),
			),
		)

		expect(phases.map(({ id }) => id)).toEqual(["build"])
	})
})
