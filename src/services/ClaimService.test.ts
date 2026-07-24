import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { cleanupTempDir, createTempDir, runTestEffect } from "../test-utils"
import { ClaimService } from "./ClaimService"
import { PhaseService } from "./PhaseService"
import { TaskService } from "./TaskService"

const at = (value: string) => new Date(value)

describe("claim service", () => {
	let root: string

	beforeEach(async () => {
		root = await createTempDir()
		await Bun.write(join(root, "agency.json"), '{"version":2}\n')
		await mkdir(join(root, "repos/agency"), { recursive: true })
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "single",
							ticketUrl: null,
							repo: "agency",
							branch: "task/single",
							base: "main",
						},
						root,
					),
				),
			),
		)
	})

	afterEach(async () => cleanupTempDir(root))

	const inspect = (taskId = "single", phaseId?: string) =>
		runTestEffect(
			ClaimService.pipe(
				Effect.flatMap((service) => service.inspect(taskId, phaseId, root)),
			),
		)

	const claim = async (
		revision: string,
		sessionId = "session-1",
		now = at("2026-07-17T12:00:00.000Z"),
		expiresAt?: string,
	) =>
		runTestEffect(
			ClaimService.pipe(
				Effect.flatMap((service) =>
					service.claim(
						{
							taskId: "single",
							claimant: "orchestrator-1",
							runner: "agent-1",
							sessionId,
							revision,
							now,
							...(expiresAt ? { expiresAt } : {}),
						},
						root,
					),
				),
			),
		)

	test("records ownership and guarded release and finish transitions", async () => {
		const initial = await inspect()
		const acquired = await claim(
			initial.revision,
			"session-1",
			at("2026-07-17T12:00:00.000Z"),
			"2026-07-17T13:00:00.000Z",
		)

		expect(acquired.claim).toEqual({
			claimant: "orchestrator-1",
			runner: "agent-1",
			sessionId: "session-1",
			startedAt: "2026-07-17T12:00:00.000Z",
			targetRevision: initial.revision,
			expiresAt: "2026-07-17T13:00:00.000Z",
			state: "active",
		})
		expect((await inspect()).data.status).toBe("working")
		await expect(
			runTestEffect(
				TaskService.pipe(
					Effect.flatMap((service) =>
						service.setStatus("single", "done", root),
					),
				),
			),
		).rejects.toThrow("has an active claim")

		const released = await runTestEffect(
			ClaimService.pipe(
				Effect.flatMap((service) =>
					service.release(
						{
							taskId: "single",
							sessionId: "session-1",
							revision: acquired.revision,
							now: at("2026-07-17T12:15:00.000Z"),
						},
						root,
					),
				),
			),
		)
		expect(released.data.status).toBe("open")
		expect(released.claim).toMatchObject({
			state: "released",
			releasedAt: "2026-07-17T12:15:00.000Z",
		})

		const reacquired = await claim(
			released.revision,
			"session-2",
			at("2026-07-17T12:20:00.000Z"),
		)
		const finished = await runTestEffect(
			ClaimService.pipe(
				Effect.flatMap((service) =>
					service.finish(
						{
							taskId: "single",
							sessionId: "session-2",
							revision: reacquired.revision,
							outcome: "done",
							now: at("2026-07-17T12:45:00.000Z"),
						},
						root,
					),
				),
			),
		)
		expect(finished.data.status).toBe("working")
		expect(finished.claim).toMatchObject({
			state: "finished",
			finishedAt: "2026-07-17T12:45:00.000Z",
			outcome: "done",
		})
	})

	test("finishes claimed non-PR work with durable completion evidence", async () => {
		const initial = await inspect()
		const acquired = await claim(initial.revision)
		const finished = await runTestEffect(
			ClaimService.pipe(
				Effect.flatMap((service) =>
					service.finish(
						{
							taskId: "single",
							sessionId: "session-1",
							revision: acquired.revision,
							outcome: "done",
							nonPrCompletion: {
								summary: "Review completed; no code change was needed.",
								evidenceUrl: "https://example.com/review",
							},
							now: at("2026-07-17T12:45:00.000Z"),
						},
						root,
					),
				),
			),
		)

		expect(finished.data).toMatchObject({
			status: "done",
			claim: { state: "finished", outcome: "done" },
			completion: {
				mode: "non-pr",
				completedAt: "2026-07-17T12:45:00.000Z",
				summary: "Review completed; no code change was needed.",
				evidenceUrl: "https://example.com/review",
			},
		})
	})

	test("rejects invalid claimed non-PR completion", async () => {
		const initial = await inspect()
		const acquired = await claim(initial.revision)
		await expect(
			runTestEffect(
				ClaimService.pipe(
					Effect.flatMap((service) =>
						service.finish(
							{
								taskId: "single",
								sessionId: "session-1",
								revision: acquired.revision,
								outcome: "done",
								nonPrCompletion: { summary: " " },
							},
							root,
						),
					),
				),
			),
		).rejects.toThrow("summary must not be empty")
	})

	test("returns structured ownership and revision conflicts", async () => {
		const initial = await inspect()
		const acquired = await claim(initial.revision)

		await expect(claim(acquired.revision, "session-2")).rejects.toThrow(
			"is claimed by 'agent-1'",
		)
		await expect(
			runTestEffect(
				ClaimService.pipe(
					Effect.flatMap((service) =>
						service.release(
							{
								taskId: "single",
								sessionId: "session-2",
								revision: acquired.revision,
							},
							root,
						),
					),
				),
			),
		).rejects.toThrow("does not own")
		await expect(claim(initial.revision, "session-3")).rejects.toThrow(
			"Revision conflict",
		)
	})

	test("serializes concurrent claims and allows expired ownership replacement", async () => {
		const initial = await inspect()
		const attempts = await Promise.allSettled([
			claim(initial.revision, "session-a"),
			claim(initial.revision, "session-b"),
		])
		expect(
			attempts.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1)
		expect(
			attempts.filter((result) => result.status === "rejected"),
		).toHaveLength(1)
		const current = await inspect()
		expect(current.data.claim?.state).toBe("active")

		await runTestEffect(
			ClaimService.pipe(
				Effect.flatMap((service) =>
					service.release(
						{
							taskId: "single",
							sessionId: current.data.claim!.sessionId,
							revision: current.revision,
						},
						root,
					),
				),
			),
		)
		const released = await inspect()
		const expiring = await claim(
			released.revision,
			"expiring",
			at("2026-07-17T12:00:00.000Z"),
			"2026-07-17T12:01:00.000Z",
		)
		const replacement = await claim(
			expiring.revision,
			"replacement",
			at("2026-07-17T12:02:00.000Z"),
		)
		expect(replacement.claim.sessionId).toBe("replacement")
	})

	test("claims phases and rejects multi-phase task containers", async () => {
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{ id: "multi", ticketUrl: null, multiPhase: true },
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
							branch: "task/multi",
							base: "main",
						},
						root,
					),
				),
			),
		)
		await expect(inspect("multi")).rejects.toThrow("claim a phase instead")
		const phase = await inspect("multi", "implementation")
		const acquired = await runTestEffect(
			ClaimService.pipe(
				Effect.flatMap((service) =>
					service.claim(
						{
							taskId: "multi",
							phaseId: "implementation",
							claimant: "orchestrator",
							runner: "agent",
							sessionId: "phase-session",
							revision: phase.revision,
						},
						root,
					),
				),
			),
		)
		expect(acquired.target).toBe("phase 'multi/implementation'")
	})
})
