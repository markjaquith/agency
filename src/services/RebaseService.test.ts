import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { Effect } from "effect"
import { cleanupTempDir, createTempDir, runTestEffect } from "../test-utils"
import { rebase as rebaseCommand } from "../commands/rebase"
import {
	hasPendingRebase,
	RebaseService,
	type RebaseOptions,
} from "./RebaseService"
import { TaskService } from "./TaskService"

const git = (cwd: string, ...args: string[]) => {
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Test",
			GIT_AUTHOR_EMAIL: "test@example.com",
			GIT_COMMITTER_NAME: "Test",
			GIT_COMMITTER_EMAIL: "test@example.com",
		},
	})
	if (result.exitCode !== 0)
		throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`)
	return result.stdout.toString().trim()
}

const commit = async (cwd: string, file: string, content = file) => {
	await Bun.write(join(cwd, file), `${content}\n`)
	git(cwd, "add", file)
	git(cwd, "commit", "-q", "-m", `change ${file}`)
	return git(cwd, "rev-parse", "HEAD")
}

const subjects = (cwd: string, range: string) =>
	git(cwd, "log", "--format=%s", range).split("\n").filter(Boolean)

describe("RebaseService", () => {
	let root: string
	let checkout: string
	let upstream: string

	const run = <A>(
		effect: (service: RebaseService) => Effect.Effect<A, unknown, any>,
	) =>
		runTestEffect(
			Effect.gen(function* () {
				return yield* effect(yield* RebaseService)
			}),
		)
	const rebase = (options: Partial<RebaseOptions> = {}) =>
		run((service) => service.rebase({ taskId: "alpha", ...options }, root))
	const task = (id = "alpha") =>
		runTestEffect(
			Effect.gen(function* () {
				return yield* (yield* TaskService).show(id, root)
			}),
		)

	beforeEach(async () => {
		root = await createTempDir()
		await Bun.write(join(root, "agency.json"), '{"version":2}\n')
		await mkdir(join(root, "repos/agency"), { recursive: true })
		const remote = join(root, "remote.git")
		git(root, "init", "-q", "--bare", "-b", "main", remote)
		upstream = join(root, "upstream")
		git(root, "clone", "-q", remote, upstream)
		git(upstream, "checkout", "-q", "-b", "main")
		await commit(upstream, "root.txt")
		git(upstream, "push", "-q", "origin", "main")
		git(upstream, "checkout", "-q", "-b", "stacked")
		await commit(upstream, "stacked.txt")
		git(upstream, "push", "-q", "origin", "stacked")

		await runTestEffect(
			Effect.gen(function* () {
				yield* (yield* TaskService).create(
					{
						id: "alpha",
						ticketUrl: null,
						repo: "agency",
						branch: "task/alpha",
						base: "stacked",
					},
					root,
				)
			}),
		)
		checkout = join(root, "tasks/alpha/code/agency")
		git(root, "clone", "-q", remote, checkout)
		git(checkout, "checkout", "-q", "-b", "task/alpha", "origin/stacked")
		await commit(checkout, "alpha.txt")

		// The stacked work lands on main as a squash commit, then main moves on.
		git(upstream, "checkout", "-q", "main")
		await commit(upstream, "stacked.txt", "squashed")
		await commit(upstream, "upstream.txt")
		git(upstream, "push", "-q", "origin", "main")
	})

	afterEach(async () => cleanupTempDir(root))

	test("dry run reports the plan without changing anything", async () => {
		const head = git(checkout, "rev-parse", "HEAD")
		const before = await task()
		const output = await rebase({ onto: "main", dryRun: true })
		expect(output).toMatchObject({
			status: "planned",
			dryRun: true,
			previousBase: "stacked",
			base: "main",
			onto: { ref: "refs/remotes/origin/main" },
			replayed: [{ subject: "change alpha.txt" }],
			dropped: [{ subject: "change stacked.txt" }],
			recorded: false,
		})
		expect(git(checkout, "rev-parse", "HEAD")).toBe(head)
		expect((await task()).revision).toBe(before.revision)
	})

	test("replays only branch commits onto the new base and records it", async () => {
		const output = await rebase({ onto: "main" })
		expect(output).toMatchObject({
			status: "rebased",
			recorded: true,
			changedPaths: ["tasks/alpha/TASK.md"],
		})
		expect(subjects(checkout, "origin/main..HEAD")).toEqual([
			"change alpha.txt",
		])
		expect(git(checkout, "rev-parse", "HEAD^")).toBe(
			git(checkout, "rev-parse", "origin/main"),
		)
		const record = await task()
		expect(record.data).toMatchObject({ base: "main" })
		expect(record.content).toContain("## Base History")
		expect(record.content).toContain(
			"base changed from `stacked` to `main` by `agency rebase`",
		)
	})

	test("without --onto refreshes the current base without recording", async () => {
		git(upstream, "checkout", "-q", "stacked")
		await commit(upstream, "more.txt")
		git(upstream, "push", "-q", "origin", "stacked")
		const before = await task()
		const output = await rebase()
		expect(output).toMatchObject({
			status: "rebased",
			base: "stacked",
			recorded: false,
		})
		expect(subjects(checkout, "origin/stacked..HEAD")).toEqual([
			"change alpha.txt",
		])
		expect((await task()).revision).toBe(before.revision)
	})

	test("refuses a dirty checkout", async () => {
		await Bun.write(join(checkout, "alpha.txt"), "dirty\n")
		await expect(rebase({ onto: "main" })).rejects.toThrow(
			"uncommitted changes",
		)
	})

	test("refuses a stale --if-revision before touching Git", async () => {
		const head = git(checkout, "rev-parse", "HEAD")
		await expect(rebase({ onto: "main", ifRevision: "stale" })).rejects.toThrow(
			"Revision conflict",
		)
		expect(git(checkout, "rev-parse", "HEAD")).toBe(head)
	})

	test("warns about dependents and publication without changing dependencies", async () => {
		git(checkout, "push", "-q", "origin", "task/alpha")
		await runTestEffect(
			Effect.gen(function* () {
				yield* (yield* TaskService).create(
					{
						id: "beta",
						ticketUrl: null,
						repo: "agency",
						branch: "task/beta",
						base: "task/alpha",
					},
					root,
				)
			}),
		)
		const output = await rebase({ onto: "main", dryRun: true })
		const reported: string[] = []
		await runTestEffect(
			rebaseCommand({
				taskId: "alpha",
				onto: "main",
				dryRun: true,
				cwd: root,
				silent: true,
				onWarnings: (warnings) => reported.push(...warnings),
			}),
		)
		expect(reported).toEqual(output.warnings)
		expect(output.warnings).toEqual(
			expect.arrayContaining([
				expect.stringContaining(
					"git push --force-with-lease origin task/alpha",
				),
				expect.stringContaining("task:beta is based on 'task/alpha'"),
			]),
		)
	})

	describe("conflicts", () => {
		beforeEach(async () => {
			git(upstream, "checkout", "-q", "main")
			await commit(upstream, "alpha.txt", "upstream version")
			git(upstream, "push", "-q", "origin", "main")
		})

		test("leaves metadata unchanged and aborts cleanly", async () => {
			const head = git(checkout, "rev-parse", "HEAD")
			const error = await rebase({ onto: "main" }).catch((cause) => cause)
			expect(String(error)).toContain("--continue")
			expect((await task()).data).toMatchObject({ base: "stacked" })
			const pending = () => runTestEffect(hasPendingRebase(checkout))
			expect(await pending()).toBe(true)
			await expect(rebase({ onto: "main" })).rejects.toThrow(
				"already in progress",
			)

			const aborted = await run((service) =>
				service.abortRebase({ taskId: "alpha" }, root),
			)
			expect(aborted).toMatchObject({ status: "aborted", head })
			expect(await pending()).toBe(false)
			expect(git(checkout, "rev-parse", "HEAD")).toBe(head)
			expect((await task()).data).toMatchObject({ base: "stacked" })
			await expect(
				run((service) => service.abortRebase({ taskId: "alpha" }, root)),
			).rejects.toThrow("No Agency rebase is in progress")
		})

		test("continues after resolution and records the base", async () => {
			await rebase({ onto: "main" }).catch(() => undefined)
			await expect(
				run((service) => service.continueRebase({ taskId: "alpha" }, root)),
			).rejects.toThrow("--continue")

			await Bun.write(join(checkout, "alpha.txt"), "resolved\n")
			git(checkout, "add", "alpha.txt")
			const output = await run((service) =>
				service.continueRebase({ taskId: "alpha" }, root),
			)
			expect(output).toMatchObject({ status: "rebased", recorded: true })
			expect(git(checkout, "rev-parse", "HEAD^")).toBe(
				git(checkout, "rev-parse", "origin/main"),
			)
			expect((await task()).data).toMatchObject({ base: "main" })
		})
	})
})
