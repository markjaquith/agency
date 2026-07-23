import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { chmod, mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { cleanupTempDir, createTempDir, runTestEffect } from "../test-utils"
import { ClaimService } from "./ClaimService"
import { PullRequestService } from "./PullRequestService"
import { SyncService } from "./SyncService"
import { TaskService } from "./TaskService"
import { WorktreeService } from "./WorktreeService"
import { WorkbaseService } from "./WorkbaseService"

const git = async (args: string[], cwd?: string) => {
	const process = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	})
	await process.exited
	if (process.exitCode !== 0) {
		throw new Error(await new Response(process.stderr).text())
	}
}

describe("SyncService", () => {
	let root: string
	let originalPath: string | undefined

	beforeEach(async () => {
		root = await createTempDir()
		await Bun.write(join(root, "agency.json"), '{"version":2}\n')
		const source = join(root, "source")
		await mkdir(source, { recursive: true })
		await git(["init", "--initial-branch=main"], source)
		await git(["config", "user.email", "test@example.com"], source)
		await git(["config", "user.name", "Test"], source)
		await Bun.write(join(source, "README.md"), "example\n")
		await git(["add", "README.md"], source)
		await git(["-c", "commit.gpgsign=false", "commit", "-m", "initial"], source)
		await mkdir(join(root, "repos"), { recursive: true })
		await git(["clone", "--bare", source, join(root, "repos/agency")])
		await git(["clone", "--bare", source, join(root, "repos/reference")])

		const bin = join(root, "bin")
		await mkdir(bin)
		const gh = join(bin, "gh")
		await Bun.write(
			gh,
			`#!/bin/sh
case "$*" in
*mergeable*) ;;
*) echo "mergeable field was not requested" >&2; exit 2 ;;
esac
if [ "$2" = "view" ]; then
cat <<'JSON'
{"number":42,"state":"MERGED","title":"Ship","isDraft":false,"headRefName":"feat/example","baseRefName":"main","url":"https://github.com/example/agency/pull/42","mergedAt":"2100-01-01T00:00:00Z","mergeCommit":{"oid":"abc"},"mergeable":"MERGEABLE"}
JSON
exit 0
fi
cat <<'JSON'
[{"number":42,"state":"MERGED","title":"Ship","isDraft":false,"headRefName":"feat/example","baseRefName":"main","url":"https://github.com/example/agency/pull/42","mergedAt":"2100-01-01T00:00:00Z","mergeCommit":{"oid":"abc"},"mergeable":"MERGEABLE"}]
JSON
`,
		)
		await chmod(gh, 0o755)
		originalPath = process.env.PATH
		process.env.PATH = `${bin}:${originalPath}`
	})

	afterEach(async () => {
		if (originalPath === undefined) delete process.env.PATH
		else process.env.PATH = originalPath
		await cleanupTempDir(root)
	})

	test("validates before applying repository setup", async () => {
		await rm(join(root, "repos/agency"), { recursive: true, force: true })
		await Bun.write(
			join(root, "agency.json"),
			JSON.stringify({
				version: 2,
				repositories: {
					agency: { remote: "https://example.com/agency.git" },
				},
			}),
		)
		await mkdir(join(root, "tasks/invalid"), { recursive: true })
		await Bun.write(
			join(root, "tasks/invalid/TASK.md"),
			`---
ticketUrl: null
repo: unknown
branch: task/invalid
base: main
pr: null
---
`,
		)

		await expect(
			runTestEffect(
				SyncService.pipe(
					Effect.flatMap((service) =>
						service.reconcile({ cwd: root, apply: true }),
					),
				),
			),
		).rejects.toThrow("Unknown repository alias 'unknown'")
		expect(await Bun.file(join(root, "repos/agency")).exists()).toBe(false)
	})

	test("observes drift without mutation and applies only safe transitions", async () => {
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "example",
							ticketUrl: null,
							repo: "agency",
							repos: [{ repo: "reference", ref: "main" }],
							branch: "feat/example",
							base: "main",
						},
						root,
					),
				),
			),
		)
		const workspace = await runTestEffect(
			WorktreeService.pipe(
				Effect.flatMap((service) =>
					service.materialize("example", undefined, root),
				),
			),
		)
		await git(
			["remote", "set-url", "origin", "git@github.com:example/agency.git"],
			join(root, "repos/agency"),
		)
		const inspected = await runTestEffect(
			ClaimService.pipe(
				Effect.flatMap((service) =>
					service.inspect("example", undefined, root),
				),
			),
		)
		await runTestEffect(
			ClaimService.pipe(
				Effect.flatMap((service) =>
					service.claim(
						{
							taskId: "example",
							claimant: "orchestrator",
							runner: "agent",
							sessionId: "session-1",
							revision: inspected.revision,
							expiresAt: "2099-01-01T00:00:00.000Z",
						},
						root,
					),
				),
			),
		)
		await Bun.write(
			join(workspace.codePath, "reference", "LOCAL.md"),
			"dirty\n",
		)

		const taskPath = join(root, "tasks/example/TASK.md")
		const before = await Bun.file(taskPath).text()
		const observed = await runTestEffect(
			SyncService.pipe(
				Effect.flatMap((service) =>
					service.reconcile({ cwd: root, now: new Date("2100-01-02") }),
				),
			),
		)

		expect(observed.mode).toBe("dry-run")
		expect(observed.warnings).toContainEqual(
			expect.objectContaining({
				kind: "dirty-reference",
				target: "task:example",
			}),
		)
		expect(observed.changes.map((change) => change.kind)).toEqual([
			"release-stale-claim",
			"record-pr",
			"mark-done",
		])
		expect(await Bun.file(taskPath).text()).toBe(before)

		const applied = await runTestEffect(
			SyncService.pipe(
				Effect.flatMap((service) =>
					service.reconcile({
						cwd: root,
						apply: true,
						now: new Date("2100-01-02"),
					}),
				),
			),
		)
		expect(applied.changes.map((change) => change.kind)).toEqual([
			"release-stale-claim",
			"record-pr",
			"mark-done",
		])
		expect(applied.changes.every((change) => change.status === "applied")).toBe(
			true,
		)
		const task = await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) => service.show("example", root)),
			),
		)
		expect(task.data).toMatchObject({
			status: "done",
			pr: {
				provider: "github",
				repository: "example/agency",
				identifier: "42",
				url: "https://github.com/example/agency/pull/42",
				state: "merged",
				draft: false,
				merged: true,
				mergeable: true,
			},
			claim: { state: "released", sessionId: "session-1" },
		})
	})

	test("records a conflicting open PR without changing lifecycle status", async () => {
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "example",
							ticketUrl: null,
							repo: "agency",
							branch: "feat/example",
							base: "main",
						},
						root,
					),
				),
			),
		)
		await runTestEffect(
			WorktreeService.pipe(
				Effect.flatMap((service) =>
					service.materialize("example", undefined, root),
				),
			),
		)
		await git(
			["remote", "set-url", "origin", "git@github.com:example/agency.git"],
			join(root, "repos/agency"),
		)
		await runTestEffect(
			PullRequestService.pipe(
				Effect.flatMap((service) =>
					service.setUrl(
						"example",
						undefined,
						"https://github.com/example/agency/pull/42",
						root,
					),
				),
			),
		)
		await Bun.write(
			join(root, "bin", "gh"),
			`#!/bin/sh
cat <<'JSON'
{"number":42,"state":"OPEN","title":"Ship","isDraft":false,"headRefName":"feat/example","baseRefName":"main","url":"https://github.com/example/agency/pull/42","mergedAt":null,"mergeCommit":null,"mergeable":"CONFLICTING"}
JSON
`,
		)
		await chmod(join(root, "bin", "gh"), 0o755)

		const applied = await runTestEffect(
			SyncService.pipe(
				Effect.flatMap((service) =>
					service.reconcile({ cwd: root, apply: true }),
				),
			),
		)
		expect(applied.changes).toContainEqual(
			expect.objectContaining({ kind: "record-pr", target: "task:example" }),
		)
		expect(applied.changes.some((change) => change.kind === "mark-done")).toBe(
			false,
		)
		const task = await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) => service.show("example", root)),
			),
		)
		expect(task.data).toMatchObject({
			status: "open",
			pr: { state: "open", merged: false, mergeable: false },
		})
	})

	test("queries and records a configured delivery provider", async () => {
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "custom",
							ticketUrl: null,
							repo: "agency",
							branch: "feat/custom",
							base: "main",
						},
						root,
					),
				),
			),
		)
		await runTestEffect(
			WorktreeService.pipe(
				Effect.flatMap((service) =>
					service.materialize("custom", undefined, root),
				),
			),
		)
		await git(
			[
				"remote",
				"set-url",
				"origin",
				"https://forge.example/example/agency.git",
			],
			join(root, "repos/agency"),
		)
		const callPath = join(root, "query-call.json")
		const record = {
			provider: "forge",
			repository: "example/agency",
			identifier: "17",
			url: "https://forge.example/example/agency/pulls/17",
			state: "open",
			draft: false,
			merged: false,
		} as const
		await Bun.write(
			join(root, "bin", "deliver"),
			`#!/usr/bin/env bun
await Bun.write(${JSON.stringify(callPath)}, JSON.stringify({ args: Bun.argv.slice(2), base: process.env.DELIVERY_BASE }))
process.stdout.write(${JSON.stringify(JSON.stringify(record))})
`,
		)
		await chmod(join(root, "bin", "deliver"), 0o755)
		await Bun.write(
			join(root, "agency.json"),
			JSON.stringify({
				version: 2,
				delivery: {
					provider: "forge",
					createCommand: ["deliver", "create"],
					queryCommand: ["deliver", "query", "{repository}", "{branch}"],
					environment: { DELIVERY_BASE: "{base}" },
				},
			}),
		)

		const result = await runTestEffect(
			SyncService.pipe(
				Effect.flatMap((service) =>
					service.reconcile({ cwd: root, apply: true }),
				),
			),
		)
		expect(result.changes).toContainEqual(
			expect.objectContaining({ kind: "record-pr", target: "task:custom" }),
		)
		expect(await Bun.file(callPath).json()).toEqual({
			args: ["query", "example/agency", "feat/custom"],
			base: "main",
		})
		const task = await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) => service.show("custom", root)),
			),
		)
		expect("pr" in task.data && task.data.pr).toEqual(record)
	})

	test("marks a successfully finished claim done only after merge", async () => {
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "finished-claim",
							ticketUrl: null,
							repo: "agency",
							branch: "feat/example",
							base: "main",
						},
						root,
					),
				),
			),
		)
		await runTestEffect(
			WorktreeService.pipe(
				Effect.flatMap((service) =>
					service.materialize("finished-claim", undefined, root),
				),
			),
		)
		await git(
			["remote", "set-url", "origin", "git@github.com:example/agency.git"],
			join(root, "repos/agency"),
		)
		const initial = await runTestEffect(
			ClaimService.pipe(
				Effect.flatMap((service) =>
					service.inspect("finished-claim", undefined, root),
				),
			),
		)
		const claimed = await runTestEffect(
			ClaimService.pipe(
				Effect.flatMap((service) =>
					service.claim(
						{
							taskId: "finished-claim",
							claimant: "orchestrator",
							runner: "agent",
							sessionId: "session-1",
							revision: initial.revision,
						},
						root,
					),
				),
			),
		)
		const finished = await runTestEffect(
			ClaimService.pipe(
				Effect.flatMap((service) =>
					service.finish(
						{
							taskId: "finished-claim",
							sessionId: "session-1",
							revision: claimed.revision,
							outcome: "done",
						},
						root,
					),
				),
			),
		)
		expect(finished.data).toMatchObject({
			status: "working",
			claim: { state: "finished", outcome: "done" },
		})

		const synced = await runTestEffect(
			SyncService.pipe(
				Effect.flatMap((service) =>
					service.reconcile({ cwd: root, apply: true }),
				),
			),
		)
		expect(synced.changes.map((change) => change.kind)).toContain("mark-done")
		expect(
			await runTestEffect(
				TaskService.pipe(
					Effect.flatMap((service) => service.show("finished-claim", root)),
				),
			),
		).toMatchObject({
			data: {
				status: "done",
				claim: { state: "finished", outcome: "done" },
			},
		})
	})

	test("materializes missing workspaces but leaves branch conflicts unresolved", async () => {
		for (const [id, branch] of [
			["missing", "feat/missing"],
			["conflict", "feat/conflict"],
		] as const) {
			await runTestEffect(
				TaskService.pipe(
					Effect.flatMap((service) =>
						service.create(
							{ id, ticketUrl: null, repo: "agency", branch, base: "main" },
							root,
						),
					),
				),
			)
		}
		const repository = join(root, "repos/agency")
		await git(["branch", "feat/conflict", "main"], repository)
		await git(
			["worktree", "add", join(root, "external-conflict"), "feat/conflict"],
			repository,
		)

		const observed = await runTestEffect(
			SyncService.pipe(
				Effect.flatMap((service) => service.reconcile({ cwd: root })),
			),
		)
		expect(observed.changes).toContainEqual(
			expect.objectContaining({
				kind: "materialize-workspace",
				target: "task:missing",
				status: "planned",
			}),
		)
		expect(observed.unresolved).toContainEqual(
			expect.objectContaining({
				kind: "branch-conflict",
				target: "task:conflict",
			}),
		)
		expect(
			await Bun.file(
				join(root, "tasks/missing/code/agency/README.md"),
			).exists(),
		).toBe(false)

		const applied = await runTestEffect(
			SyncService.pipe(
				Effect.flatMap((service) =>
					service.reconcile({ cwd: root, apply: true }),
				),
			),
		)
		expect(applied.changes).toContainEqual(
			expect.objectContaining({
				kind: "materialize-workspace",
				target: "task:missing",
				status: "applied",
			}),
		)
		expect(
			applied.executions.find((item) => item.target === "task:missing")
				?.checkouts[0],
		).toMatchObject({ exists: true, registered: true, dirty: false })
		expect(
			await Bun.file(join(root, "tasks/missing/code/agency/README.md")).text(),
		).toBe("example\n")
		expect(
			await Bun.file(
				join(root, "tasks/conflict/code/agency/README.md"),
			).exists(),
		).toBe(false)
	})

	test("leaves a missing checkout registration unresolved", async () => {
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "stale",
							ticketUrl: null,
							repo: "agency",
							branch: "feat/stale",
							base: "main",
						},
						root,
					),
				),
			),
		)
		const workspace = await runTestEffect(
			WorktreeService.pipe(
				Effect.flatMap((service) =>
					service.materialize("stale", undefined, root),
				),
			),
		)
		await rm(workspace.writablePath, { recursive: true, force: true })

		const observed = await runTestEffect(
			SyncService.pipe(
				Effect.flatMap((service) => service.reconcile({ cwd: root })),
			),
		)
		expect(observed.changes).toEqual([])
		expect(observed.unresolved).toContainEqual(
			expect.objectContaining({
				kind: "stale-registration",
				target: "task:stale",
			}),
		)

		const applied = await runTestEffect(
			SyncService.pipe(
				Effect.flatMap((service) =>
					service.reconcile({ cwd: root, apply: true }),
				),
			),
		)
		expect(applied.changes).toEqual([])
		expect(
			await Bun.file(join(workspace.writablePath, "README.md")).exists(),
		).toBe(false)
	})

	test("does not trust a recorded PR from another repository", async () => {
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "example",
							ticketUrl: null,
							repo: "agency",
							branch: "feat/example",
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
						"example",
						undefined,
						"https://github.com/other/repository/pull/42",
						root,
					),
				),
			),
		)

		const applied = await runTestEffect(
			SyncService.pipe(
				Effect.flatMap((service) =>
					service.reconcile({ cwd: root, apply: true }),
				),
			),
		)
		expect(applied.unresolved).toContainEqual(
			expect.objectContaining({
				kind: "pr-repository-conflict",
				target: "task:example",
			}),
		)
		expect(applied.changes.some((change) => change.kind === "mark-done")).toBe(
			false,
		)
		const task = await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) => service.show("example", root)),
			),
		)
		expect(task.data).toMatchObject({ status: "open" })
	})

	test("leaves non-PR completion unchanged when a matching PR is discoverable", async () => {
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "non-pr",
							ticketUrl: null,
							repo: "agency",
							branch: "feat/example",
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
					service.setStatus("non-pr", "done", root, {
						summary: "Investigation completed without changes.",
					}),
				),
			),
		)

		for (let attempt = 0; attempt < 2; attempt += 1) {
			const applied = await runTestEffect(
				SyncService.pipe(
					Effect.flatMap((service) =>
						service.reconcile({ cwd: root, apply: true }),
					),
				),
			)
			expect(
				applied.changes.some(
					(change) =>
						change.kind === "record-pr" || change.kind === "mark-done",
				),
			).toBe(false)
		}

		const task = await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) => service.show("non-pr", root)),
			),
		)
		expect(task.data).toMatchObject({
			status: "done",
			pr: null,
			completion: {
				mode: "non-pr",
				summary: "Investigation completed without changes.",
			},
		})
		expect(
			await runTestEffect(
				WorkbaseService.pipe(
					Effect.flatMap((service) => service.validate(root)),
				),
			),
		).toMatchObject({ valid: true, issues: [] })
	})
})
