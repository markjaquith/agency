import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { cleanupTempDir, createTempDir, runTestEffect } from "../test-utils"
import { TaskService } from "./TaskService"
import { ReviewService } from "./ReviewService"
import { WorktreeService } from "./WorktreeService"
import { ContextService } from "./ContextService"
import { GraphService } from "./GraphService"
import { PullRequestService } from "./PullRequestService"
import { PhaseService } from "./PhaseService"
import { ArchiveService } from "./ArchiveService"
import { ClaimService } from "./ClaimService"
import { SyncService } from "./SyncService"
import { task as taskCommand } from "../commands/task"

const git = async (args: string[], cwd?: string) => {
	const child = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	})
	await child.exited
	if (child.exitCode !== 0)
		throw new Error(await new Response(child.stderr).text())
}

describe("ReviewService", () => {
	let root: string
	let source: string

	beforeEach(async () => {
		root = await createTempDir()
		source = join(root, "source")
		await Bun.write(join(root, "agency.json"), '{"version":2}\n')
		await mkdir(source, { recursive: true })
		await git(["init", "--initial-branch=main"], source)
		await git(["config", "user.email", "test@example.com"], source)
		await git(["config", "user.name", "Test"], source)
		await Bun.write(join(source, "README.md"), "initial\n")
		await git(["add", "README.md"], source)
		await git(["-c", "commit.gpgsign=false", "commit", "-m", "initial"], source)
		await git(["switch", "-c", "review-me"], source)
		await Bun.write(join(source, "README.md"), "review one\n")
		await git(["commit", "-am", "review one"], source)
		await mkdir(join(root, "repos"), { recursive: true })
		await git(["clone", "--bare", source, join(root, "repos/agency")])
	})

	afterEach(async () => cleanupTempDir(root))

	const createReview = async () => {
		const review = await runTestEffect(
			ReviewService.pipe(
				Effect.flatMap((service) =>
					service.resolve("agency", { ref: "review-me" }, root),
				),
			),
		)
		return runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create({ id: "review", ticketUrl: null, review }, root),
				),
			),
		)
	}

	test("pins, materializes, reports, and explicitly refreshes a branch review", async () => {
		const created = await createReview()
		const original = "review" in created.data ? created.data.review.commit : ""
		expect("review" in created.data && created.data.review.commit).toMatch(
			/^[a-f0-9]{40}$/,
		)
		const workspace = await runTestEffect(
			WorktreeService.pipe(
				Effect.flatMap((service) =>
					service.materialize("review", undefined, root),
				),
			),
		)
		expect(workspace.writablePath).toBeNull()
		expect(workspace.reviewPath).toBe(join(workspace.codePath, "agency"))
		expect(
			await Bun.file(join(workspace.codePath, "agency/README.md")).text(),
		).toBe("review one\n")
		const branch = Bun.spawnSync([
			"git",
			"-C",
			join(workspace.codePath, "agency"),
			"branch",
			"--show-current",
		])
		expect(new TextDecoder().decode(branch.stdout).trim()).toBe("")

		const context = await runTestEffect(
			ContextService.pipe(
				Effect.flatMap((service) =>
					service.get({ target: "review", cwd: root }),
				),
			),
		)
		expect(context.authority.mode).toBe("review")
		expect(context.authority.writable).toBeNull()
		expect(context.authority.references).toHaveLength(1)
		expect(context.authority.documents.writable).toEqual([created.path])
		expect(context.pr).toEqual({ url: null, state: "none" })

		const graph = await runTestEffect(
			GraphService.pipe(
				Effect.flatMap((service) =>
					service.get({ cwd: root, include: ["workspace", "git", "pr"] }),
				),
			),
		)
		expect(
			graph.edges.some(
				(edge) => edge.kind === "writes" && edge.from.includes("review"),
			),
		).toBe(false)
		expect(
			graph.edges.some(
				(edge) => edge.kind === "references" && edge.from.includes("review"),
			),
		).toBe(true)

		await Bun.write(join(source, "README.md"), "review two\n")
		await git(["commit", "-am", "review two"], source)
		const refreshed = await runTestEffect(
			ReviewService.pipe(
				Effect.flatMap((service) =>
					service.refresh("review", root, created.revision),
				),
			),
		)
		expect(refreshed.changed).toBe(true)
		expect(
			await Bun.file(join(workspace.codePath, "agency/README.md")).text(),
		).toBe("review two\n")
		const oldPins = Bun.spawnSync([
			"git",
			"-C",
			join(root, "repos/agency"),
			"for-each-ref",
			"--format=%(refname)",
			"--points-at",
			original,
			"refs/agency/reviews",
		])
		expect(new TextDecoder().decode(oldPins.stdout).trim()).toBe("")
	})

	test("rejects delivery and phase operations even when forced", async () => {
		await createReview()
		await expect(
			runTestEffect(
				PullRequestService.pipe(
					Effect.flatMap((service) =>
						service.create("review", undefined, false, root, { force: true }),
					),
				),
			),
		).rejects.toThrow("cannot create a delivery pull request")
		await expect(
			runTestEffect(
				PhaseService.pipe(
					Effect.flatMap((service) =>
						service.create(
							{
								taskId: "review",
								id: "phase",
								firstPhase: "original",
								repo: "agency",
								branch: "phase",
								base: "main",
							},
							root,
						),
					),
				),
			),
		).rejects.toThrow("cannot be converted to phases")
	})

	test("participates in claim lifecycle", async () => {
		const task = await createReview()
		const claimed = await runTestEffect(
			ClaimService.pipe(
				Effect.flatMap((service) =>
					service.claim(
						{
							taskId: "review",
							claimant: "reviewer",
							runner: "opencode",
							sessionId: "session",
							revision: task.revision,
						},
						root,
					),
				),
			),
		)
		expect(claimed.data.status).toBe("working")
		const released = await runTestEffect(
			ClaimService.pipe(
				Effect.flatMap((service) =>
					service.release(
						{
							taskId: "review",
							sessionId: "session",
							revision: claimed.revision,
						},
						root,
					),
				),
			),
		)
		expect(released.data.status).toBe("open")
	})

	test("rejects refresh while actively claimed", async () => {
		const task = await createReview()
		await runTestEffect(
			ClaimService.pipe(
				Effect.flatMap((service) =>
					service.claim(
						{
							taskId: "review",
							claimant: "reviewer",
							runner: "opencode",
							sessionId: "active",
							revision: task.revision,
						},
						root,
					),
				),
			),
		)
		await expect(
			runTestEffect(
				ReviewService.pipe(
					Effect.flatMap((service) => service.refresh("review", root)),
				),
			),
		).rejects.toThrow("active claim")
	})

	test("rolls back document and checkout when pin advancement fails", async () => {
		const created = await createReview()
		const workspace = await runTestEffect(
			WorktreeService.pipe(
				Effect.flatMap((service) =>
					service.materialize("review", undefined, root),
				),
			),
		)
		const original = "review" in created.data ? created.data.review.commit : ""
		await Bun.write(join(source, "README.md"), "new source\n")
		await git(["commit", "-am", "new source"], source)
		await git(
			["update-ref", "refs/agency/reviews/726576696577", "main"],
			join(root, "repos/agency"),
		)
		await expect(
			runTestEffect(
				ReviewService.pipe(
					Effect.flatMap((service) => service.refresh("review", root)),
				),
			),
		).rejects.toThrow("rolled back")
		const current = await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) => service.show("review", root)),
			),
		)
		expect("review" in current.data && current.data.review.commit).toBe(
			original,
		)
		expect(
			await Bun.file(join(workspace.reviewPath!, "README.md")).text(),
		).toBe("review one\n")
	})

	test("blocks refresh of a dirty detached checkout", async () => {
		await createReview()
		const workspace = await runTestEffect(
			WorktreeService.pipe(
				Effect.flatMap((service) =>
					service.materialize("review", undefined, root),
				),
			),
		)
		await Bun.write(join(workspace.codePath, "agency/dirty.txt"), "dirty\n")
		await expect(
			runTestEffect(
				ReviewService.pipe(
					Effect.flatMap((service) => service.refresh("review", root)),
				),
			),
		).rejects.toThrow("dirty or structurally unexpected")
	})

	test("rejects unsafe branch sources and mixed create inputs", async () => {
		for (const ref of [
			"HEAD",
			"refs/tags/v1",
			"--upload-pack=evil",
			"feature:*",
			"feature/*",
			"feature..bad",
		]) {
			await expect(
				runTestEffect(
					ReviewService.pipe(
						Effect.flatMap((service) =>
							service.resolve("agency", { ref }, root),
						),
					),
				),
			).rejects.toThrow("Invalid review branch")
		}
		const resolved = await runTestEffect(
			ReviewService.pipe(
				Effect.flatMap((service) =>
					service.resolve("agency", { ref: "origin/review-me" }, root),
				),
			),
		)
		expect(resolved.source).toEqual({
			kind: "branch",
			ref: "refs/heads/review-me",
		})
		await expect(
			runTestEffect(
				TaskService.pipe(
					Effect.flatMap((service) =>
						service.create(
							{
								id: "mixed",
								ticketUrl: null,
								review: resolved,
								repo: "agency",
								branch: "mixed",
								base: "main",
							},
							root,
						),
					),
				),
			),
		).rejects.toThrow("cannot include writable")
	})

	test("removes a task-scoped pin when task creation fails", async () => {
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "review",
							ticketUrl: null,
							repo: "agency",
							branch: "task/review",
							base: "main",
						},
						root,
					),
				),
			),
		)
		await expect(
			runTestEffect(
				taskCommand({
					subcommand: "create",
					args: ["review"],
					review: "agency",
					ref: "review-me",
					cwd: root,
					silent: true,
				}),
			),
		).rejects.toThrow("already exists")
		const pin = Bun.spawnSync([
			"git",
			"-C",
			join(root, "repos/agency"),
			"show-ref",
			"--verify",
			"refs/agency/reviews/726576696577",
		])
		expect(pin.exitCode).not.toBe(0)
	})

	test("CLI creation stores no writable execution defaults", async () => {
		await runTestEffect(
			taskCommand({
				subcommand: "create",
				args: ["command-review"],
				review: "agency",
				ref: "origin/review-me",
				cwd: root,
				silent: true,
			}),
		)
		const created = await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) => service.show("command-review", root)),
			),
		)
		expect("review" in created.data).toBe(true)
		expect("repo" in created.data).toBe(false)
		expect("branch" in created.data).toBe(false)
		expect("base" in created.data).toBe(false)
	})

	test("sync observes source movement without changing the pin", async () => {
		const created = await createReview()
		const original = "review" in created.data ? created.data.review.commit : ""
		await Bun.write(join(source, "README.md"), "moved\n")
		await git(["commit", "-am", "move source"], source)
		const synced = await runTestEffect(
			SyncService.pipe(
				Effect.flatMap((service) => service.reconcile({ cwd: root })),
			),
		)
		const state = synced.executions.find(
			(execution) => execution.target === "task:review",
		)
		expect(state?.review?.pinnedCommit).toBe(original)
		expect(state?.review?.sourceCommit).not.toBe(original)
		const current = await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) => service.show("review", root)),
			),
		)
		expect("review" in current.data && current.data.review.commit).toBe(
			original,
		)
	})

	test("archives the pinned checkout after its source branch is deleted", async () => {
		await createReview()
		const workspace = await runTestEffect(
			WorktreeService.pipe(
				Effect.flatMap((service) =>
					service.materialize("review", undefined, root),
				),
			),
		)
		await git(["switch", "main"], source)
		await git(["branch", "-D", "review-me"], source)
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) => service.setStatus("review", "done", root)),
			),
		)
		const archived = await runTestEffect(
			ArchiveService.pipe(
				Effect.flatMap((service) => service.archiveTask("review", root)),
			),
		)
		expect(archived.removedWorktrees).toContain(
			join(workspace.codePath, "agency"),
		)
		expect(await Bun.file(join(archived.path, "TASK.md")).exists()).toBe(true)
	})
})
