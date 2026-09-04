import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { cleanupTempDir, createTempDir, runTestEffect } from "../test-utils"
import { EpicService } from "./EpicService"
import { TaskService } from "./TaskService"
import { PhaseService } from "./PhaseService"
import { PullRequestService } from "./PullRequestService"

describe("task and phase services", () => {
	let root: string

	beforeEach(async () => {
		root = await createTempDir()
		await Bun.write(join(root, "agency.json"), '{"version":2}\n')
		await mkdir(join(root, "repos/agency"), { recursive: true })
		await mkdir(join(root, "repos/effect"), { recursive: true })
	})

	afterEach(async () => cleanupTempDir(root))

	test("creates a single-phase task and updates its epic", async () => {
		await runTestEffect(
			EpicService.pipe(
				Effect.flatMap((service) =>
					service.create(
						"example",
						"https://example.com/epic",
						[{ repo: "agency", ref: "main" }],
						root,
					),
				),
			),
		)
		const createdTask = await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "task-one",
							ticketUrl: "https://example.com/task",
							epic: "example",
							repo: "agency",
							repos: [{ repo: "effect", ref: "main" }],
							branch: "task/one",
							base: "main",
						},
						root,
					),
				),
			),
		)
		expect(createdTask.content).toContain(
			"# Task One\n\n## Outcome\n\nDescribe the task outcome.\n\n## Plan\n\nDescribe the current approach.\n\n## Important Decisions\n\nRecord consequential decisions and their rationale.",
		)

		const epic = await runTestEffect(
			EpicService.pipe(
				Effect.flatMap((service) => service.show("example", root)),
			),
		)
		expect(epic.data.tasks).toEqual([{ id: "task-one" }])
	})

	test("does not create a task when its parent update cannot start", async () => {
		await runTestEffect(
			EpicService.pipe(
				Effect.flatMap((service) =>
					service.create(
						"locked",
						"https://example.com/epic",
						[{ repo: "agency", ref: "main" }],
						root,
					),
				),
			),
		)
		const lock = join(root, ".agency-graph-mutation.lock")
		await Bun.write(lock, "held")
		await expect(
			runTestEffect(
				TaskService.pipe(
					Effect.flatMap((service) =>
						service.create(
							{
								id: "not-created",
								ticketUrl: null,
								epic: "locked",
								repo: "agency",
								branch: "task/not-created",
								base: "main",
							},
							root,
						),
					),
				),
			),
		).rejects.toThrow("Another graph mutation is in progress")
		await rm(lock)
		expect(
			await Bun.file(join(root, "tasks/not-created/TASK.md")).exists(),
		).toBe(false)
		const epic = await runTestEffect(
			EpicService.pipe(
				Effect.flatMap((service) => service.show("locked", root)),
			),
		)
		expect(epic.data.tasks).toEqual([])
	})

	test("creates revision-bound task and phase investigation handoffs", async () => {
		const source = await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "investigate",
							ticketUrl: null,
							multiPhase: true,
							purpose: "investigation",
						},
						root,
					),
				),
			),
		)
		const phase = await runTestEffect(
			PhaseService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							taskId: "investigate",
							id: "evidence",
							repo: "agency",
							branch: "task/investigate-evidence",
							base: "main",
						},
						root,
					),
				),
			),
		)
		const currentSource = await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) => service.show("investigate", root)),
			),
		)
		const sourceContent = await Bun.file(source.path).text()
		const phaseContent = await Bun.file(phase.path).text()

		const fromTask = await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.handoff(
						{
							sourceTaskId: "investigate",
							id: "implement-task",
							ticketUrl: null,
							repo: "agency",
							branch: "task/implement-task",
							base: "main",
						},
						root,
					),
				),
			),
		)
		const fromPhase = await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.handoff(
						{
							sourceTaskId: "investigate",
							sourcePhaseId: "evidence",
							id: "implement-phase",
							ticketUrl: null,
							repo: "effect",
							branch: "task/implement-phase",
							base: "main",
						},
						root,
					),
				),
			),
		)

		expect(fromTask.source).toEqual({
			selector: "task/investigate",
			documentPath: source.path,
			revision: currentSource.revision,
		})
		expect(fromPhase.source).toEqual({
			selector: "phase/investigate/evidence",
			documentPath: phase.path,
			revision: phase.revision,
		})
		expect(fromPhase.validation.valid).toBe(true)
		expect(fromPhase.worktreePrepare.command).toEqual([
			"agency",
			"worktree",
			"prepare",
			"implement-phase",
		])
		expect(await Bun.file(source.path).text()).toBe(sourceContent)
		expect(await Bun.file(phase.path).text()).toBe(phaseContent)
		expect(
			await Bun.file(join(root, "tasks/implement-phase/code")).exists(),
		).toBe(false)

		const created = await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) => service.show("implement-phase", root)),
			),
		)
		expect(created.data).toMatchObject({
			purpose: "implementation",
			handoff: {
				source: {
					kind: "phase",
					taskId: "investigate",
					phaseId: "evidence",
				},
				sourceRevision: phase.revision,
			},
			status: "open",
		})
		await Bun.write(
			phase.path,
			phaseContent.replace(
				"Describe the phase outcome.",
				"Recorded evidence remains stale-safe.",
			),
		)
		const staleSource = await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) => service.show("implement-phase", root)),
			),
		)
		expect(staleSource.data.handoff?.sourceRevision).toBe(phase.revision)

		await expect(
			runTestEffect(
				TaskService.pipe(
					Effect.flatMap((service) =>
						service.handoff(
							{
								sourceTaskId: "investigate",
								id: "implement-task",
								ticketUrl: null,
								repo: "agency",
								branch: "task/duplicate",
								base: "main",
							},
							root,
						),
					),
				),
			),
		).rejects.toThrow("already exists")

		await mkdir(join(root, "archive/tasks/reserved"), { recursive: true })
		await expect(
			runTestEffect(
				TaskService.pipe(
					Effect.flatMap((service) =>
						service.handoff(
							{
								sourceTaskId: "investigate",
								id: "reserved",
								ticketUrl: null,
								repo: "agency",
								branch: "task/reserved",
								base: "main",
							},
							root,
						),
					),
				),
			),
		).rejects.toThrow("explicit creation requires a different ID")
	})

	test("rolls back handoff creation when a source revision is stale", async () => {
		const source = await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "stale-investigation",
							ticketUrl: null,
							repo: "agency",
							branch: "task/stale-investigation",
							base: "main",
							purpose: "investigation",
						},
						root,
					),
				),
			),
		)
		const staleRevision = source.revision
		await Bun.write(
			source.path,
			`${source.content}\nChanged after inspection.\n`,
		)

		await expect(
			runTestEffect(
				TaskService.pipe(
					Effect.flatMap((service) =>
						service.create(
							{
								id: "stale-implementation",
								ticketUrl: null,
								repo: "effect",
								branch: "task/stale-implementation",
								base: "main",
								purpose: "implementation",
								handoff: {
									source: {
										kind: "task",
										taskId: "stale-investigation",
									},
									sourceRevision: staleRevision,
								},
								preconditions: [{ path: source.path, revision: staleRevision }],
							},
							root,
						),
					),
				),
			),
		).rejects.toThrow("Revision conflict")
		expect(
			await Bun.file(join(root, "tasks/stale-implementation/TASK.md")).exists(),
		).toBe(false)
	})

	test("creates and sequences phases on a multi-phase task", async () => {
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
		for (const phase of [
			{ id: "first", dependsOn: undefined },
			{ id: "second", dependsOn: ["first"] },
		]) {
			await runTestEffect(
				PhaseService.pipe(
					Effect.flatMap((service) =>
						service.create(
							{
								taskId: "multi",
								id: phase.id,
								repo: "agency",
								branch: `task/${phase.id}`,
								base: "main",
								dependsOn: phase.dependsOn,
							},
							root,
						),
					),
				),
			)
		}

		const task = await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) => service.show("multi", root)),
			),
		)
		expect("phases" in task.data && task.data.phases).toEqual([
			{ id: "first" },
			{ id: "second", dependsOn: ["first"] },
		])
		const phases = await runTestEffect(
			PhaseService.pipe(
				Effect.flatMap((service) => service.list("multi", root)),
			),
		)
		expect(phases.map((phase) => phase.id)).toEqual(["first", "second"])
		const firstPhase = await runTestEffect(
			PhaseService.pipe(
				Effect.flatMap((service) => service.show("multi", "first", root)),
			),
		)
		expect(firstPhase.content).toContain(
			"# First\n\n## Outcome\n\nDescribe the phase outcome.\n\n## Plan\n\nDescribe the current approach.\n\n## Important Decisions\n\nRecord consequential decisions and their rationale.",
		)
	})

	test("converts a single-phase task when the existing phase ID is provided", async () => {
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "single",
							ticketUrl: "https://example.com/task",
							description: "Deliver the complete task.",
							repo: "agency",
							repos: [{ repo: "effect", ref: "main" }],
							branch: "task/single",
							base: "main",
							purpose: "implementation",
							handoff: {
								source: { kind: "task", taskId: "investigation" },
								sourceRevision: "a".repeat(64),
							},
						},
						root,
					),
				),
			),
		)
		await runTestEffect(
			PullRequestService.pipe(
				Effect.flatMap((service) =>
					service.setUrl(
						"single",
						undefined,
						"https://github.com/example/agency/pull/42",
						root,
					),
				),
			),
		)
		await expect(
			runTestEffect(
				PhaseService.pipe(
					Effect.flatMap((service) =>
						service.create(
							{
								taskId: "single",
								id: "extra",
								repo: "agency",
								branch: "task/extra",
								base: "main",
							},
							root,
						),
					),
				),
			),
		).rejects.toThrow("requires --first-phase")

		await runTestEffect(
			PhaseService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							taskId: "single",
							id: "extra",
							firstPhase: "implementation",
							repo: "agency",
							branch: "task/extra",
							base: "main",
							dependsOn: ["implementation"],
						},
						root,
					),
				),
			),
		)

		const task = await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) => service.show("single", root)),
			),
		)
		expect(task.data).toEqual({
			ticketUrl: "https://example.com/task",
			description: "Deliver the complete task.",
			purpose: "implementation",
			handoff: {
				source: { kind: "task", taskId: "investigation" },
				sourceRevision: "a".repeat(64),
			},
			phases: [
				{ id: "implementation" },
				{ id: "extra", dependsOn: ["implementation"] },
			],
		})
		expect(task.content).toContain(
			"## Outcome\n\nDescribe the task outcome.\n\n## Plan\n\nDescribe the current approach.\n\n## Important Decisions",
		)

		const firstPhase = await runTestEffect(
			PhaseService.pipe(
				Effect.flatMap((service) =>
					service.show("single", "implementation", root),
				),
			),
		)
		expect(firstPhase.data).toEqual({
			repo: "agency",
			repos: [{ repo: "effect", ref: "main" }],
			branch: "task/single",
			base: "main",
			pr: {
				provider: "github",
				repository: "example/agency",
				identifier: "42",
				url: "https://github.com/example/agency/pull/42",
				state: "open",
				draft: false,
				merged: false,
			},
			status: "open",
		})
	})

	test("preserves non-PR completion when converting a task to phases", async () => {
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "completed",
							ticketUrl: null,
							repo: "agency",
							branch: "task/completed",
							base: "main",
						},
						root,
					),
				),
			),
		)
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.setStatus("completed", "done", root, {
						summary: "Investigation completed without changes.",
					}),
				),
			),
		)
		await runTestEffect(
			PhaseService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							taskId: "completed",
							id: "follow-up",
							firstPhase: "investigation",
							repo: "agency",
							branch: "task/completed-follow-up",
							base: "main",
						},
						root,
					),
				),
			),
		)

		const firstPhase = await runTestEffect(
			PhaseService.pipe(
				Effect.flatMap((service) =>
					service.show("completed", "investigation", root),
				),
			),
		)
		expect(firstPhase.data).toMatchObject({
			status: "done",
			completion: {
				mode: "non-pr",
				summary: "Investigation completed without changes.",
			},
		})
	})

	test("updates status on execution units", async () => {
		const createdTask = await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "single-status",
							ticketUrl: "https://example.com/task",
							repo: "agency",
							branch: "task/single-status",
							base: "main",
						},
						root,
					),
				),
			),
		)
		expect(createdTask.content).toContain("status: open")
		const workingTask = await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.setStatus("single-status", "working", root),
				),
			),
		)
		expect(workingTask.data.status).toBe("working")
		await expect(
			runTestEffect(
				TaskService.pipe(
					Effect.flatMap((service) =>
						service.setStatus("single-status", "delegated", root),
					),
				),
			),
		).rejects.toThrow("Delegated status cannot be set directly")
		await Bun.write(
			createdTask.path,
			workingTask.content.replace("status: working", "status: delegated"),
		)
		const reopenedDelegatedTask = await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.setStatus("single-status", "open", root),
				),
			),
		)
		expect(reopenedDelegatedTask.data.status).toBe("open")
		await expect(
			runTestEffect(
				TaskService.pipe(
					Effect.flatMap((service) =>
						service.setStatus("single-status", "done", root),
					),
				),
			),
		).rejects.toThrow("authoritative pull request is merged")
		const completedTask = await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.setStatus("single-status", "done", root, {
						summary: "Investigation completed without repository changes.",
						evidenceUrl: "https://example.com/investigation",
					}),
				),
			),
		)
		expect(completedTask.data).toMatchObject({
			status: "done",
			completion: {
				mode: "non-pr",
				summary: "Investigation completed without repository changes.",
				evidenceUrl: "https://example.com/investigation",
			},
		})
		expect(completedTask.data.completion?.completedAt).toMatch(
			/^\d{4}-\d{2}-\d{2}T/,
		)
		await expect(
			runTestEffect(
				PullRequestService.pipe(
					Effect.flatMap((service) =>
						service.setUrl(
							"single-status",
							undefined,
							"https://github.com/example/agency/pull/1",
							root,
						),
					),
				),
			),
		).rejects.toThrow("Reopen non-PR completed work")
		const reopenedTask = await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.setStatus("single-status", "open", root),
				),
			),
		)
		expect(reopenedTask.data.status).toBe("open")
		expect("completion" in reopenedTask.data).toBe(false)
		const droppedTask = await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.setStatus("single-status", "dropped", root),
				),
			),
		)
		expect(droppedTask.data.status).toBe("dropped")
		await expect(
			runTestEffect(
				TaskService.pipe(
					Effect.flatMap((service) =>
						service.setStatus("single-status", "done", root, {
							summary: "Cannot bypass reopening.",
						}),
					),
				),
			),
		).rejects.toThrow("reopen it first")

		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "multi-status",
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
							taskId: "multi-status",
							id: "implementation",
							repo: "agency",
							branch: "task/multi-status",
							base: "main",
						},
						root,
					),
				),
			),
		)
		const workingPhase = await runTestEffect(
			PhaseService.pipe(
				Effect.flatMap((service) =>
					service.setStatus("multi-status", "implementation", "working", root),
				),
			),
		)
		expect(workingPhase.data.status).toBe("working")
		const phase = await runTestEffect(
			PhaseService.pipe(
				Effect.flatMap((service) =>
					service.setStatus("multi-status", "implementation", "dropped", root),
				),
			),
		)
		expect(phase.data.status).toBe("dropped")
		await expect(
			runTestEffect(
				PhaseService.pipe(
					Effect.flatMap((service) =>
						service.setStatus("multi-status", "implementation", "done", root),
					),
				),
			),
		).rejects.toThrow("authoritative pull request is merged")
		await runTestEffect(
			PhaseService.pipe(
				Effect.flatMap((service) =>
					service.setStatus("multi-status", "implementation", "open", root),
				),
			),
		)
		await expect(
			runTestEffect(
				PhaseService.pipe(
					Effect.flatMap((service) =>
						service.setStatus("multi-status", "implementation", "done", root),
					),
				),
			),
		).rejects.toThrow("authoritative pull request is merged")
		await expect(
			runTestEffect(
				PhaseService.pipe(
					Effect.flatMap((service) =>
						service.setStatus("multi-status", "implementation", "done", root, {
							summary: "   ",
						}),
					),
				),
			),
		).rejects.toThrow("summary must not be empty")
		const completedPhase = await runTestEffect(
			PhaseService.pipe(
				Effect.flatMap((service) =>
					service.setStatus("multi-status", "implementation", "done", root, {
						summary: "Operational work completed outside the repository.",
					}),
				),
			),
		)
		expect(completedPhase.data).toMatchObject({
			status: "done",
			completion: {
				mode: "non-pr",
				summary: "Operational work completed outside the repository.",
			},
		})

		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "recorded-pr",
							ticketUrl: null,
							repo: "agency",
							branch: "task/recorded-pr",
							base: "main",
						},
						root,
					),
				),
			),
		)
		await runTestEffect(
			PullRequestService.pipe(
				Effect.flatMap((service) =>
					service.setUrl(
						"recorded-pr",
						undefined,
						"https://github.com/example/agency/pull/1",
						root,
					),
				),
			),
		)
		await expect(
			runTestEffect(
				TaskService.pipe(
					Effect.flatMap((service) =>
						service.setStatus("recorded-pr", "done", root, {
							summary: "Attempted bypass",
						}),
					),
				),
			),
		).rejects.toThrow("authoritative pull request is recorded")
		await expect(
			runTestEffect(
				TaskService.pipe(
					Effect.flatMap((service) =>
						service.setStatus("multi-status", "done", root),
					),
				),
			),
		).rejects.toThrow("set status on a phase instead")
	})
})
