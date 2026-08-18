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

const jj = async (args: string[], cwd?: string) => {
	const process = Bun.spawn(["jj", ...args], {
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
if [ -n "$GH_CAPTURE" ]; then printf '%s\n' "$@" "GIT_DIR=$GIT_DIR" > "$GH_CAPTURE"; fi
case "$*" in
*mergeable*) ;;
*) echo "mergeable field was not requested" >&2; exit 2 ;;
esac
case "$*" in
*baseRepository*) echo "unsupported baseRepository field was requested" >&2; exit 3 ;;
esac
if [ "$2" = "view" ]; then
cat <<'JSON'
{"number":42,"state":"MERGED","title":"Ship","isDraft":false,"headRefName":"feat/example","baseRefName":"main","headRepository":{"nameWithOwner":"example/agency"},"url":"https://github.com/example/agency/pull/42","mergedAt":"2100-01-01T00:00:00Z","mergeCommit":{"oid":"abc"},"mergeable":"MERGEABLE"}
JSON
exit 0
fi
cat <<'JSON'
[{"number":42,"state":"MERGED","title":"Ship","isDraft":false,"headRefName":"feat/example","baseRefName":"main","headRepository":{"nameWithOwner":"example/agency"},"url":"https://github.com/example/agency/pull/42","mergedAt":"2100-01-01T00:00:00Z","mergeCommit":{"oid":"abc"},"mergeable":"MERGEABLE"}]
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
		delete process.env.GH_CAPTURE
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

	test("reconciles jj workspaces through the jj backend", async () => {
		if (!Bun.which("jj")) return
		const repository = join(root, "repos/agency")
		await rm(repository, { recursive: true, force: true })
		await jj([
			"git",
			"clone",
			"--no-colocate",
			join(root, "source"),
			repository,
		])
		expect(await Bun.file(join(repository, ".git")).exists()).toBe(false)
		await Bun.write(
			join(root, "agency.json"),
			JSON.stringify({ version: 2, vcs: "jj" }),
		)
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "jj-sync",
							ticketUrl: null,
							repo: "agency",
							branch: "task/jj-sync",
							base: "main",
						},
						root,
					),
				),
			),
		)
		const capture = join(root, "gh-capture")
		process.env.GH_CAPTURE = capture

		const planned = await runTestEffect(
			SyncService.pipe(
				Effect.flatMap((service) => service.reconcile({ cwd: root })),
			),
		)
		expect(planned.changes).toContainEqual(
			expect.objectContaining({
				kind: "materialize-workspace",
				target: "task:jj-sync",
				status: "planned",
			}),
		)
		const invocation = await Bun.file(capture).text()
		expect(invocation).toContain("--repo\n")
		expect(invocation).not.toContain("baseRepository")
		expect(invocation).toContain("GIT_DIR=")
		expect(invocation).toContain(".jj")

		const applied = await runTestEffect(
			SyncService.pipe(
				Effect.flatMap((service) =>
					service.reconcile({ cwd: root, apply: true }),
				),
			),
		)
		expect(applied.executions[0]?.checkouts[0]).toMatchObject({
			exists: true,
			registered: true,
			branch: "task/jj-sync",
			dirty: false,
		})
		delete process.env.GH_CAPTURE
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
							agent: "agent",
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
				headRepository: "example/agency",
				headBranch: "feat/example",
				baseRepository: "example/agency",
				baseBranch: "main",
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
{"number":42,"state":"OPEN","title":"Ship","isDraft":false,"headRefName":"feat/example","baseRefName":"main","headRepository":{"nameWithOwner":"example/agency"},"baseRepository":{"nameWithOwner":"example/agency"},"url":"https://github.com/example/agency/pull/42","mergedAt":null,"mergeCommit":null,"mergeable":"CONFLICTING"}
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
							agent: "agent",
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
		await Bun.write(join(root, "bin", "gh"), "#!/bin/sh\nprintf '[]\\n'\n")
		await chmod(join(root, "bin", "gh"), 0o755)
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

	test("reconciles a recorded merged PR without materializing an absent checkout", async () => {
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "recorded-merged",
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
		await git(
			["remote", "set-url", "origin", "git@github.com:example/agency.git"],
			join(root, "repos/agency"),
		)
		await runTestEffect(
			PullRequestService.pipe(
				Effect.flatMap((service) =>
					service.setUrl(
						"recorded-merged",
						undefined,
						"https://github.com/example/agency/pull/42",
						root,
					),
				),
			),
		)

		const applied = await runTestEffect(
			SyncService.pipe(
				Effect.flatMap((service) =>
					service.reconcile({
						cwd: root,
						apply: true,
						taskId: "recorded-merged",
					}),
				),
			),
		)
		expect(applied.changes.map((change) => change.kind)).toEqual([
			"record-pr",
			"mark-done",
		])
		expect(applied.executions[0]?.checkouts).toEqual([])
		expect(
			await Bun.file(join(root, "tasks/recorded-merged/code/agency")).exists(),
		).toBe(false)
	})

	test("reconciles a uniquely discovered merged PR without materializing", async () => {
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "discovered-merged",
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
		await git(
			["remote", "set-url", "origin", "git@github.com:example/agency.git"],
			join(root, "repos/agency"),
		)

		const applied = await runTestEffect(
			SyncService.pipe(
				Effect.flatMap((service) =>
					service.reconcile({
						cwd: root,
						apply: true,
						taskId: "discovered-merged",
					}),
				),
			),
		)
		expect(applied.changes.map((change) => change.kind)).toEqual([
			"record-pr",
			"mark-done",
		])
		expect(applied.executions[0]?.checkouts).toEqual([])
		expect(
			await Bun.file(
				join(root, "tasks/discovered-merged/code/agency"),
			).exists(),
		).toBe(false)
	})

	test("materializes when discovered PR evidence is ambiguous", async () => {
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "ambiguous",
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
		const gh = await Bun.file(join(root, "bin", "gh")).text()
		await Bun.write(
			join(root, "bin", "gh"),
			gh
				.replace('[{"number":42', '[{"number":42')
				.replace(
					"]\nJSON\n",
					`,{\"number\":43,\"state\":\"MERGED\",\"title\":\"Ship again\",\"isDraft\":false,\"headRefName\":\"feat/example\",\"baseRefName\":\"main\",\"headRepository\":{\"nameWithOwner\":\"example/agency\"},\"url\":\"https://github.com/example/agency/pull/43\",\"mergedAt\":\"2100-01-01T00:00:00Z\",\"mergeCommit\":{\"oid\":\"def\"},\"mergeable\":\"MERGEABLE\"}]\nJSON\n`,
				),
		)

		const applied = await runTestEffect(
			SyncService.pipe(
				Effect.flatMap((service) =>
					service.reconcile({
						cwd: root,
						apply: true,
						taskId: "ambiguous",
					}),
				),
			),
		)
		expect(applied.unresolved).toContainEqual(
			expect.objectContaining({ kind: "multiple-prs" }),
		)
		expect(applied.changes).toContainEqual(
			expect.objectContaining({ kind: "materialize-workspace" }),
		)
		expect(
			await Bun.file(
				join(root, "tasks/ambiguous/code/agency/README.md"),
			).text(),
		).toBe("example\n")
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
		await rm(workspace.writablePath!, { recursive: true, force: true })

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
			await Bun.file(join(workspace.writablePath!, "README.md")).exists(),
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

	test("reconciles a merged upstream PR whose head is the writable fork", async () => {
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "forked",
							ticketUrl: null,
							repo: "agency",
							branch: "task/polish-readme",
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
					service.materialize("forked", undefined, root),
				),
			),
		)
		await git(
			["remote", "set-url", "origin", "git@github.com:markjaquith/Pasted.git"],
			join(root, "repos/agency"),
		)
		await runTestEffect(
			PullRequestService.pipe(
				Effect.flatMap((service) =>
					service.setUrl(
						"forked",
						undefined,
						"https://github.com/getpasted/pasted/pull/17",
						root,
					),
				),
			),
		)
		await Bun.write(
			join(root, "bin", "gh"),
			`#!/bin/sh
cat <<'JSON'
{"number":17,"state":"MERGED","title":"Polish README","isDraft":false,"headRefName":"task/polish-readme","baseRefName":"main","headRepository":{"nameWithOwner":"markjaquith/Pasted"},"baseRepository":{"nameWithOwner":"getpasted/pasted"},"url":"https://github.com/getpasted/pasted/pull/17","mergedAt":"2026-08-11T00:00:00Z","mergeCommit":{"oid":"241d45da1115ef685c91a5e6882d118c16801550"},"mergeable":"UNKNOWN"}
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
		expect(
			applied.unresolved.filter((notice) => notice.target === "task:forked"),
		).toEqual([])
		expect(applied.changes.map((change) => change.kind)).toEqual([
			"record-pr",
			"mark-done",
		])
		const task = await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) => service.show("forked", root)),
			),
		)
		expect(task.data).toMatchObject({
			status: "done",
			pr: {
				repository: "getpasted/pasted",
				headRepository: "markjaquith/Pasted",
				headBranch: "task/polish-readme",
				baseRepository: "getpasted/pasted",
				baseBranch: "main",
				state: "merged",
				merged: true,
			},
		})
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

	test("reads each repository workspace inventory once", async () => {
		for (const id of ["first", "second"]) {
			await runTestEffect(
				TaskService.pipe(
					Effect.flatMap((service) =>
						service.create(
							{
								id,
								ticketUrl: null,
								repo: "agency",
								branch: `feat/${id}`,
								base: "main",
							},
							root,
						),
					),
				),
			)
			await runTestEffect(
				WorktreeService.pipe(
					Effect.flatMap((service) => service.materialize(id, undefined, root)),
				),
			)
			await runTestEffect(
				TaskService.pipe(
					Effect.flatMap((service) =>
						service.setStatus(id, "done", root, {
							summary: `Completed ${id}`,
						}),
					),
				),
			)
		}

		const callsPath = join(root, "workspace-list-calls")
		const realGit = Bun.which("git")!
		const gitWrapper = join(root, "bin", "git")
		await Bun.write(
			gitWrapper,
			`#!/bin/sh
case "$*" in
*"worktree list --porcelain -z"*) printf 'call\\n' >> ${JSON.stringify(callsPath)} ;;
esac
exec ${JSON.stringify(realGit)} "$@"
`,
		)
		await chmod(gitWrapper, 0o755)

		await runTestEffect(
			SyncService.pipe(
				Effect.flatMap((service) => service.reconcile({ cwd: root })),
			),
		)
		expect((await Bun.file(callsPath).text()).trim().split("\n")).toHaveLength(
			1,
		)
	})

	test("queries pull request providers concurrently", async () => {
		for (const id of ["first", "second", "third"]) {
			await runTestEffect(
				TaskService.pipe(
					Effect.flatMap((service) =>
						service.create(
							{
								id,
								ticketUrl: null,
								repo: "agency",
								branch: `feat/${id}`,
								base: "main",
							},
							root,
						),
					),
				),
			)
		}

		const barrier = join(root, "query-barrier")
		await mkdir(barrier)
		await Bun.write(
			join(root, "bin", "gh"),
			`#!/bin/sh
branch=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--head" ]; then branch="$2"; break; fi
  shift
done
id="\${branch##*/}"
touch ${JSON.stringify(barrier)}/"\${id}"
attempt=0
while [ "$attempt" -lt 200 ]; do
  set -- ${JSON.stringify(barrier)}/*
  if [ -e "$1" ] && [ "$#" -ge 3 ]; then printf '[]\\n'; exit 0; fi
  attempt=$((attempt + 1))
  sleep 0.01
done
echo "provider queries were serialized" >&2
exit 9
`,
		)
		await chmod(join(root, "bin", "gh"), 0o755)

		const result = await runTestEffect(
			SyncService.pipe(
				Effect.flatMap((service) => service.reconcile({ cwd: root })),
			),
		)
		expect(
			result.warnings.filter(
				(warning) => warning.kind === "pr-discovery-unavailable",
			),
		).toEqual([])
	})

	test("keeps pull request query failures concise", async () => {
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "unavailable",
							ticketUrl: null,
							repo: "agency",
							branch: "feat/unavailable",
							base: "main",
						},
						root,
					),
				),
			),
		)
		await Bun.write(
			join(root, "bin", "gh"),
			`#!/bin/sh
echo "Unknown JSON field: unsupported" >&2
echo "Available fields:" >&2
echo "  additions" >&2
exit 1
`,
		)
		await chmod(join(root, "bin", "gh"), 0o755)

		const result = await runTestEffect(
			SyncService.pipe(
				Effect.flatMap((service) => service.reconcile({ cwd: root })),
			),
		)
		expect(result.warnings).toContainEqual({
			kind: "pr-discovery-unavailable",
			target: "task:unavailable",
			message: "Unknown JSON field: unsupported",
		})
	})
})
