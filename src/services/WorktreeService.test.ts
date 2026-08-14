import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { chmod, mkdir, realpath, rename, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import {
	captureErrors,
	cleanupTempDir,
	createTempDir,
	runTestEffect,
} from "../test-utils"
import { TaskService } from "./TaskService"
import { PhaseService } from "./PhaseService"
import { WorktreeService } from "./WorktreeService"

const git = async (args: string[], cwd?: string) => {
	const process = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	})
	await process.exited
	if (process.exitCode !== 0)
		throw new Error(await new Response(process.stderr).text())
}

const jj = async (args: string[], cwd?: string) => {
	const process = Bun.spawn(["jj", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	})
	await process.exited
	if (process.exitCode !== 0)
		throw new Error(await new Response(process.stderr).text())
}

const jjOutput = async (args: string[], cwd?: string) => {
	const process = Bun.spawn(["jj", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	})
	const [exitCode, stdout, stderr] = await Promise.all([
		process.exited,
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
	])
	if (exitCode !== 0) throw new Error(stderr)
	return stdout.trim()
}

describe("WorktreeService", () => {
	let root: string
	let source: string
	let effectRepositoryInitialized: boolean

	const ensureEffectRepository = async () => {
		if (effectRepositoryInitialized) return
		await git(["clone", "--bare", source, join(root, "repos/effect")])
		effectRepositoryInitialized = true
	}

	beforeEach(async () => {
		effectRepositoryInitialized = false
		root = await createTempDir()
		await Bun.write(join(root, "agency.json"), '{"version":2}\n')
		source = join(root, "source")
		await mkdir(source, { recursive: true })
		await git(["init", "--initial-branch=main"], source)
		await git(["config", "user.email", "test@example.com"], source)
		await git(["config", "user.name", "Test"], source)
		await Bun.write(join(source, "README.md"), "example\n")
		await git(["add", "README.md"], source)
		await git(["-c", "commit.gpgsign=false", "commit", "-m", "initial"], source)
		await mkdir(join(root, "repos"), { recursive: true })
		await git(["clone", "--bare", source, join(root, "repos/agency")])
	})

	afterEach(async () => cleanupTempDir(root))

	test("materializes writable and reference worktrees", async () => {
		await ensureEffectRepository()
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "example",
							ticketUrl: "https://example.com/task",
							repo: "agency",
							repos: [{ repo: "effect", ref: "main" }],
							branch: "task/example",
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

		expect(
			await Bun.file(join(workspace.writablePath!, "README.md")).text(),
		).toBe("example\n")
		expect(
			await Bun.file(join(workspace.codePath, "effect/README.md")).text(),
		).toBe("example\n")
		const branch = Bun.spawnSync(
			["git", "-C", workspace.writablePath!, "branch", "--show-current"],
			{ stdout: "pipe" },
		)
		expect(new TextDecoder().decode(branch.stdout).trim()).toBe("task/example")
	})

	test("runs repository hooks for new writable and reference checkouts", async () => {
		await ensureEffectRepository()
		const hook = [
			"sh",
			"-c",
			'printf "%s\\n" "$@" > post-checkout-argv; env | grep "^AGENCY_" | sort > post-checkout-env; printf x >> post-checkout-count',
			"post-checkout",
			"{repoAlias}",
			"{repositoryPath}",
			"{checkoutPath}",
			"{checkoutKind}",
			"{requestedRef}",
			"{base}",
			"{vcs}",
			"{workbaseRoot}",
			"{taskId}",
			"{phaseId}",
		]
		await Bun.write(
			join(root, "agency.json"),
			JSON.stringify({
				version: 2,
				repositories: {
					agency: {
						remote: "https://example.com/agency.git",
						postCheckoutCommand: hook,
					},
					effect: {
						remote: "https://example.com/effect.git",
						postCheckoutCommand: hook,
					},
				},
			}),
		)
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "hooked",
							ticketUrl: null,
							repo: "agency",
							repos: [{ repo: "effect", ref: "main" }],
							branch: "task/hooked",
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
					service.materialize("hooked", undefined, root),
				),
			),
		)
		const writable = workspace.writablePath!
		const reference = join(workspace.codePath, "effect")
		expect(await Bun.file(join(writable, "post-checkout-argv")).text()).toBe(
			[
				"agency",
				join(root, "repos/agency"),
				writable,
				"writable",
				"task/hooked",
				"main",
				"git",
				root,
				"hooked",
				"",
				"",
			].join("\n"),
		)
		expect(
			await Bun.file(join(reference, "post-checkout-argv")).text(),
		).toContain("reference\nmain\nmain\ngit")
		const environment = await Bun.file(
			join(writable, "post-checkout-env"),
		).text()
		expect(environment).toContain(`AGENCY_CHECKOUT_PATH=${writable}\n`)
		expect(environment).toContain("AGENCY_CHECKOUT_KIND=writable\n")
		expect(environment).toContain("AGENCY_PHASE_ID=\n")
		expect(workspace.operations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					action: "post-checkout",
					repo: "agency",
					status: "completed",
				}),
				expect.objectContaining({
					action: "post-checkout",
					repo: "effect",
					status: "completed",
				}),
			]),
		)

		const reused = await runTestEffect(
			WorktreeService.pipe(
				Effect.flatMap((service) =>
					service.materialize("hooked", undefined, root),
				),
			),
		)
		expect(
			reused.operations.filter(
				(operation) => operation.action === "post-checkout",
			),
		).toEqual([])
		expect(await Bun.file(join(writable, "post-checkout-count")).text()).toBe(
			"x",
		)
		expect(await Bun.file(join(reference, "post-checkout-count")).text()).toBe(
			"x",
		)
	})

	test("materializes and removes a jj workspace for a jj workbase", async () => {
		if (!Bun.which("jj")) return
		const repository = join(root, "repos/agency")
		await rm(repository, { recursive: true, force: true })
		await git(["clone", source, repository])
		await jj(["git", "init", "--colocate", repository])
		await Bun.write(
			join(root, "agency.json"),
			JSON.stringify({
				version: 2,
				vcs: "jj",
				repositories: {
					agency: {
						remote: "https://example.com/agency.git",
						postCheckoutCommand: [
							"sh",
							"-c",
							'printf "%s:%s" "$AGENCY_VCS" "$AGENCY_CHECKOUT_KIND" > post-checkout',
						],
					},
				},
			}),
		)
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "jj-example",
							ticketUrl: null,
							repo: "agency",
							branch: "task/jj-example",
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
					service.materialize("jj-example", undefined, root),
				),
			),
		)
		const jjMetadata = await stat(join(workspace.writablePath!, ".jj"))
		expect(jjMetadata.isFile() || jjMetadata.isDirectory()).toBe(true)
		expect(
			await Bun.file(join(workspace.writablePath!, "post-checkout")).text(),
		).toBe("jj:writable")
		await jj(
			["commit", "-m", "record post-checkout output"],
			workspace.writablePath!,
		)
		const inspection = await runTestEffect(
			WorktreeService.pipe(
				Effect.flatMap((service) =>
					service.inspect("jj-example", undefined, root),
				),
			),
		)
		expect(inspection.conflicts).toEqual([])
		expect(inspection.checkouts[0]).toMatchObject({
			exists: true,
			registered: true,
			actualBranch: "task/jj-example",
		})

		await runTestEffect(
			WorktreeService.pipe(
				Effect.flatMap((service) =>
					service.remove("jj-example", undefined, root),
				),
			),
		)
		expect(await Bun.file(workspace.writablePath!).exists()).toBe(false)
	})

	test("uses a custom jj workspace creator before the post-checkout hook", async () => {
		if (!Bun.which("jj")) return
		const repository = join(root, "repos/agency")
		await rm(repository, { recursive: true, force: true })
		await git(["clone", source, repository])
		await jj(["git", "init", "--colocate", repository])
		await Bun.write(
			join(root, "agency.json"),
			JSON.stringify({
				version: 2,
				vcs: "jj",
				workspaceCreateCommand: [
					"sh",
					"-c",
					'jj -R "$1" workspace add --name "$3" -r "$4" "$2" && printf "%s\\n%s\\n" "$AGENCY_CHECKOUT_KIND" "$AGENCY_REQUESTED_REF" > "$2/creator-finished"',
					"workspace-creator",
					"{repo}",
					"{workspace}",
					"{name}",
					"{revision}",
					"{kind}",
					"{requestedRef}",
				],
				repositories: {
					agency: {
						remote: "https://example.com/agency.git",
						postCheckoutCommand: [
							"sh",
							"-c",
							'test -f creator-finished && printf "post-checkout" > hook-finished',
						],
					},
				},
			}),
		)
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "jj-custom",
							ticketUrl: null,
							repo: "agency",
							branch: "task/jj-custom",
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
					service.materialize("jj-custom", undefined, root),
				),
			),
		)
		expect(
			await Bun.file(join(workspace.writablePath!, "creator-finished")).text(),
		).toBe("writable\ntask/jj-custom\n")
		expect(
			await Bun.file(join(workspace.writablePath!, "hook-finished")).text(),
		).toBe("post-checkout")
		expect(workspace.operations[0]).toMatchObject({
			action: "create-workspace",
			command: expect.arrayContaining(["writable", "task/jj-custom"]),
			status: "completed",
		})
	})

	test("rolls back a jj workspace partially created by a custom command", async () => {
		if (!Bun.which("jj")) return
		const repository = join(root, "repos/agency")
		await rm(repository, { recursive: true, force: true })
		await git(["clone", source, repository])
		await jj(["git", "init", "--colocate", repository])
		await Bun.write(
			join(root, "agency.json"),
			JSON.stringify({
				version: 2,
				vcs: "jj",
				workspaceCreateCommand: [
					"sh",
					"-c",
					'jj -R "$1" workspace add --name "$3" -r "$4" "$2" && echo adoption-failed >&2; exit 7',
					"workspace-creator",
					"{repo}",
					"{workspace}",
					"{name}",
					"{revision}",
				],
			}),
		)
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "jj-custom-failure",
							ticketUrl: null,
							repo: "agency",
							branch: "task/jj-custom-failure",
							base: "main",
						},
						root,
					),
				),
			),
		)
		const workspacePath = join(root, "tasks/jj-custom-failure/code/agency")

		await expect(
			runTestEffect(
				WorktreeService.pipe(
					Effect.flatMap((service) =>
						service.materialize("jj-custom-failure", undefined, root),
					),
				),
			),
		).rejects.toThrow("adoption-failed")
		expect(await Bun.file(workspacePath).exists()).toBe(false)
		expect(
			await jjOutput(["workspace", "list", "-T", 'name ++ "\\n"'], repository),
		).not.toContain("agency-jj-custom-failure-task-agency")
	})

	test("rejects and rolls back a custom jj workspace at the wrong revision", async () => {
		if (!Bun.which("jj")) return
		const repository = join(root, "repos/agency")
		await rm(repository, { recursive: true, force: true })
		await git(["clone", source, repository])
		await jj(["git", "init", "--colocate", repository])
		const hookMarker = join(root, "wrong-revision-hook")
		await Bun.write(
			join(root, "agency.json"),
			JSON.stringify({
				version: 2,
				vcs: "jj",
				workspaceCreateCommand: [
					"sh",
					"-c",
					'jj -R "$1" workspace add --name "$3" -r "root()" "$2"',
					"workspace-creator",
					"{repo}",
					"{workspace}",
					"{name}",
					"{revision}",
				],
				repositories: {
					agency: {
						remote: "https://example.com/agency.git",
						postCheckoutCommand: ["sh", "-c", 'touch "$1"', "hook", hookMarker],
					},
				},
			}),
		)
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "jj-custom-wrong-revision",
							ticketUrl: null,
							repo: "agency",
							branch: "task/jj-custom-wrong-revision",
							base: "main",
						},
						root,
					),
				),
			),
		)
		const workspacePath = join(
			root,
			"tasks/jj-custom-wrong-revision/code/agency",
		)

		await expect(
			runTestEffect(
				WorktreeService.pipe(
					Effect.flatMap((service) =>
						service.materialize("jj-custom-wrong-revision", undefined, root),
					),
				),
			),
		).rejects.toThrow("failed validation")
		expect(await Bun.file(workspacePath).exists()).toBe(false)
		expect(await Bun.file(hookMarker).exists()).toBe(false)
	})

	test("suspends and resumes the exact jj working-copy target", async () => {
		if (!Bun.which("jj")) return
		const repository = join(root, "repos/agency")
		await rm(repository, { recursive: true, force: true })
		await git(["clone", source, repository])
		await jj(["git", "init", "--colocate", repository])
		await Bun.write(
			join(root, "agency.json"),
			JSON.stringify({ version: 2, vcs: "jj" }),
		)
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "jj-resume",
							ticketUrl: null,
							repo: "agency",
							branch: "task/jj-resume",
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
					service.materialize("jj-resume", undefined, root),
				),
			),
		)
		await jj(["new", "-m", "local-only parent"], workspace.writablePath!)
		await Bun.write(join(workspace.writablePath!, "local.txt"), "preserve me\n")
		await jj(
			["describe", "-m", "local working target"],
			workspace.writablePath!,
		)
		const target = await jjOutput(
			["log", "--no-graph", "-r", "@", "-T", 'commit_id ++ "\\t" ++ change_id'],
			workspace.writablePath!,
		)
		const [commitId, changeId] = target.split("\t")
		if (!commitId || !changeId)
			throw new Error(`Unexpected jj identity: ${target}`)
		await jj(["new", "-m", "temporary successor"], workspace.writablePath!)
		await jj(["edit", commitId], workspace.writablePath!)

		await runTestEffect(
			WorktreeService.pipe(
				Effect.flatMap((service) =>
					service.remove("jj-resume", undefined, root),
				),
			),
		)
		const resumePath = join(root, "tasks/jj-resume/.agency-jj-resume.json")
		const resume = await Bun.file(resumePath).json()
		expect(resume.checkouts[0]).toMatchObject({ commitId, changeId })
		expect(
			await jjOutput(
				[
					"log",
					"--no-graph",
					"-r",
					resume.checkouts[0].bookmark,
					"-T",
					"commit_id",
				],
				repository,
			),
		).toBe(commitId)
		expect(
			await jjOutput(
				["log", "--no-graph", "-r", "task/jj-resume", "-T", "commit_id"],
				repository,
			).catch(() => null),
		).toBeNull()

		await runTestEffect(
			WorktreeService.pipe(
				Effect.flatMap((service) =>
					service.materialize("jj-resume", undefined, root),
				),
			),
		)
		expect(
			await jjOutput(
				["log", "--no-graph", "-r", "@", "-T", "commit_id"],
				workspace.writablePath!,
			),
		).toBe(commitId)
		expect(
			await Bun.file(join(workspace.writablePath!, "local.txt")).text(),
		).toBe("preserve me\n")
		expect(await Bun.file(resumePath).exists()).toBe(false)
		expect(
			await jjOutput(
				[
					"log",
					"--no-graph",
					"-r",
					resume.checkouts[0].bookmark,
					"-T",
					"commit_id",
				],
				repository,
			).catch(() => null),
		).toBeNull()
	})

	test("refuses stale jj resume identity and stale registrations", async () => {
		if (!Bun.which("jj")) return
		const repository = join(root, "repos/agency")
		await rm(repository, { recursive: true, force: true })
		await git(["clone", source, repository])
		await jj(["git", "init", "--colocate", repository])
		await Bun.write(
			join(root, "agency.json"),
			JSON.stringify({ version: 2, vcs: "jj" }),
		)
		for (const id of ["stale-resume", "stale-registration"]) {
			await runTestEffect(
				TaskService.pipe(
					Effect.flatMap((service) =>
						service.create(
							{
								id,
								ticketUrl: null,
								repo: "agency",
								branch: `task/${id}`,
								base: "main",
							},
							root,
						),
					),
				),
			)
		}
		const suspended = await runTestEffect(
			WorktreeService.pipe(
				Effect.flatMap((service) =>
					service.materialize("stale-resume", undefined, root),
				),
			),
		)
		await runTestEffect(
			WorktreeService.pipe(
				Effect.flatMap((service) =>
					service.remove("stale-resume", undefined, root),
				),
			),
		)
		const resumePath = join(root, "tasks/stale-resume/.agency-jj-resume.json")
		const resume = await Bun.file(resumePath).json()
		await jj([
			"-R",
			repository,
			"bookmark",
			"delete",
			resume.checkouts[0].bookmark,
		])
		await expect(
			runTestEffect(
				WorktreeService.pipe(
					Effect.flatMap((service) =>
						service.materialize("stale-resume", undefined, root),
					),
				),
			),
		).rejects.toThrow("recorded commit, change ID, path, or internal bookmark")
		expect(await Bun.file(resumePath).exists()).toBe(true)
		expect(await Bun.file(suspended.writablePath!).exists()).toBe(false)

		const stale = await runTestEffect(
			WorktreeService.pipe(
				Effect.flatMap((service) =>
					service.materialize("stale-registration", undefined, root),
				),
			),
		)
		await rm(join(stale.writablePath!, ".jj"), { recursive: true, force: true })
		await expect(
			runTestEffect(
				WorktreeService.pipe(
					Effect.flatMap((service) =>
						service.remove("stale-registration", undefined, root),
					),
				),
			),
		).rejects.toThrow("checkout cleanliness could not be verified")
	})

	test("retains jj resume state when workspace deletion and rollback fail", async () => {
		if (!Bun.which("jj")) return
		const repository = join(root, "repos/agency")
		await rm(repository, { recursive: true, force: true })
		await git(["clone", source, repository])
		await jj(["git", "init", "--colocate", repository])
		await Bun.write(
			join(root, "agency.json"),
			JSON.stringify({ version: 2, vcs: "jj" }),
		)
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "jj-rollback",
							ticketUrl: null,
							repo: "agency",
							branch: "task/jj-rollback",
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
					service.materialize("jj-rollback", undefined, root),
				),
			),
		)
		const fakeBin = join(root, "fake-bin")
		await mkdir(fakeBin)
		const fakeRm = join(fakeBin, "rm")
		await Bun.write(
			fakeRm,
			`#!/bin/sh\nif [ "$1" = "-rf" ] && [ "$2" = ${JSON.stringify(workspace.writablePath!)} ]; then exit 1; fi\nexec ${JSON.stringify(Bun.which("rm")!)} "$@"\n`,
		)
		await chmod(fakeRm, 0o755)
		const originalPath = process.env.PATH
		process.env.PATH = `${fakeBin}:${originalPath}`
		try {
			await expect(
				runTestEffect(
					WorktreeService.pipe(
						Effect.flatMap((service) =>
							service.remove("jj-rollback", undefined, root),
						),
					),
				),
			).rejects.toThrow("requires manual recovery")
		} finally {
			process.env.PATH = originalPath
		}
		const resumePath = join(root, "tasks/jj-rollback/.agency-jj-resume.json")
		expect(await Bun.file(resumePath).exists()).toBe(true)

		await runTestEffect(
			WorktreeService.pipe(
				Effect.flatMap((service) =>
					service.materialize("jj-rollback", undefined, root),
				),
			),
		)
		expect((await stat(workspace.writablePath!)).isDirectory()).toBe(true)
		expect(await Bun.file(resumePath).exists()).toBe(false)
	})

	test("recommends a repository fetch when jj cannot resolve a base", async () => {
		if (!Bun.which("jj")) return
		const repository = join(root, "repos/agency")
		await rm(repository, { recursive: true, force: true })
		await git(["clone", source, repository])
		await jj(["git", "init", "--colocate", repository])
		await Bun.write(
			join(root, "agency.json"),
			JSON.stringify({ version: 2, vcs: "jj" }),
		)
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "jj-missing",
							ticketUrl: null,
							repo: "agency",
							branch: "task/jj-missing",
							base: "absent-base",
						},
						root,
					),
				),
			),
		)

		await expect(
			runTestEffect(
				WorktreeService.pipe(
					Effect.flatMap((service) =>
						service.materialize("jj-missing", undefined, root),
					),
				),
			),
		).rejects.toThrow("run 'agency repo fetch agency' and retry")
	})

	test("does not fetch the origin for an existing writable worktree", async () => {
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "existing",
							ticketUrl: "https://example.com/task",
							repo: "agency",
							branch: "task/existing",
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
					service.materialize("existing", undefined, root),
				),
			),
		)
		await git(
			["remote", "set-url", "origin", join(root, "missing")],
			join(root, "repos/agency"),
		)
		const reused = await runTestEffect(
			WorktreeService.pipe(
				Effect.flatMap((service) =>
					service.materialize("existing", undefined, root),
				),
			),
		)
		expect(reused.checkouts).toEqual([
			expect.objectContaining({ repo: "agency", action: "reused" }),
		])
		expect(reused.operations).toEqual([])
	})

	test("reuses an immutable reference checkout without fetching", async () => {
		await ensureEffectRepository()
		const commit = new TextDecoder()
			.decode(
				Bun.spawnSync(
					["git", "-C", join(root, "repos/effect"), "rev-parse", "main"],
					{ stdout: "pipe" },
				).stdout,
			)
			.trim()
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "immutable-reference",
							ticketUrl: "https://example.com/task",
							repo: "agency",
							repos: [{ repo: "effect", ref: commit }],
							branch: "task/immutable-reference",
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
					service.materialize("immutable-reference", undefined, root),
				),
			),
		)
		await git(
			["remote", "set-url", "origin", join(root, "missing")],
			join(root, "repos/effect"),
		)

		await expect(
			runTestEffect(
				WorktreeService.pipe(
					Effect.flatMap((service) =>
						service.materialize("immutable-reference", undefined, root),
					),
				),
			),
		).resolves.toMatchObject({ repos: [{ repo: "effect", ref: commit }] })
	})

	test("stops before materializing when workbase validation fails", async () => {
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "valid-target",
							ticketUrl: "https://example.com/task",
							repo: "agency",
							branch: "task/valid-target",
							base: "main",
						},
						root,
					),
				),
			),
		)
		await mkdir(join(root, "tasks", "missing-document"), { recursive: true })

		await expect(
			runTestEffect(
				WorktreeService.pipe(
					Effect.flatMap((service) =>
						service.materialize("valid-target", undefined, root),
					),
				),
			),
		).rejects.toThrow("Required document is missing")
		expect(
			await Bun.file(join(root, "tasks", "valid-target", "code")).exists(),
		).toBe(false)

		await expect(
			runTestEffect(
				WorktreeService.pipe(
					Effect.flatMap((service) =>
						service.materialize("valid-target", undefined, root, {
							force: true,
						}),
					),
				),
			),
		).resolves.toMatchObject({ repo: "agency" })
	})

	test("uses a configured worktree creation command", async () => {
		await Bun.write(
			join(root, "agency.json"),
			JSON.stringify({
				version: 2,
				worktreeCreateCommand: [
					"git",
					"-C",
					"{repo}",
					"worktree",
					"add",
					"-b",
					"{branch}",
					"{worktree}",
					"{base}",
				],
			}),
		)
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "configured",
							ticketUrl: "https://example.com/task",
							repo: "agency",
							branch: "task/configured",
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
					service.materialize("configured", undefined, root),
				),
			),
		)
		expect(
			await Bun.file(join(workspace.writablePath!, "README.md")).text(),
		).toBe("example\n")
	})

	test("logs the expanded configured command in verbose mode", async () => {
		await Bun.write(
			join(root, "agency.json"),
			JSON.stringify({
				version: 2,
				worktreeCreateCommand: [
					"sh",
					"-c",
					'git -C "$1" worktree add -b "$3" "$2" "$4" >/dev/null 2>&1',
					"agency-worktree",
					"{repo}",
					"{worktree}",
					"{branch}",
					"{base}",
				],
			}),
		)
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "verbose-command",
							ticketUrl: "https://example.com/task",
							repo: "agency",
							branch: "task/verbose-command",
							base: "main",
						},
						root,
					),
				),
			),
		)

		const logs = await captureErrors(() =>
			runTestEffect(
				WorktreeService.pipe(
					Effect.flatMap((service) =>
						service.materialize("verbose-command", undefined, root, {
							verbose: true,
						}),
					),
				),
			),
		)

		expect(logs).toHaveLength(1)
		expect(logs[0]).toStartWith("Running worktree command: sh -c ")
		expect(logs[0]).toContain(join(root, "repos", "agency"))
		expect(logs[0]).toContain(
			join(root, "tasks", "verbose-command", "code", "agency"),
		)
	})

	test("selects phases and rejects missing or unexpected phase IDs", async () => {
		await Bun.write(
			join(root, "agency.json"),
			JSON.stringify({
				version: 2,
				repositories: {
					agency: {
						remote: "https://example.com/agency.git",
						postCheckoutCommand: [
							"sh",
							"-c",
							'printf "%s:%s" "$AGENCY_TASK_ID" "$AGENCY_PHASE_ID" > post-checkout-owner',
						],
					},
				},
			}),
		)
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
		await runTestEffect(
			PhaseService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							taskId: "multi",
							id: "selected",
							repo: "agency",
							branch: "task/selected",
							base: "main",
						},
						root,
					),
				),
			),
		)

		await expect(
			runTestEffect(
				WorktreeService.pipe(
					Effect.flatMap((service) =>
						service.materialize("multi", undefined, root),
					),
				),
			),
		).rejects.toThrow("phase ID is required")
		await expect(
			runTestEffect(
				WorktreeService.pipe(
					Effect.flatMap((service) =>
						service.materialize("multi", "missing", root),
					),
				),
			),
		).rejects.toThrow("Phase 'missing' does not exist on task 'multi'")

		const workspace = await runTestEffect(
			WorktreeService.pipe(
				Effect.flatMap((service) =>
					service.materialize("multi", "selected", root),
				),
			),
		)
		expect(workspace.phasePath).toBe(
			join(root, "tasks/multi/phases/selected/PHASE.md"),
		)
		expect(workspace.writablePath).toBe(
			join(root, "tasks/multi/phases/selected/code/agency"),
		)
		expect(
			await Bun.file(
				join(workspace.writablePath!, "post-checkout-owner"),
			).text(),
		).toBe("multi:selected")

		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "single",
							ticketUrl: "https://example.com/task",
							repo: "agency",
							branch: "task/single",
							base: "main",
						},
						root,
					),
				),
			),
		)
		await expect(
			runTestEffect(
				WorktreeService.pipe(
					Effect.flatMap((service) =>
						service.materialize("single", "unexpected", root),
					),
				),
			),
		).rejects.toThrow("does not accept a phase ID")
	})

	test("reports meaningful worktree creation failures", async () => {
		const cases = [
			{
				id: "missing-repo",
				repo: "missing",
				base: "main",
				config: { version: 2 },
				expected: "Unknown repository alias 'missing'",
			},
			{
				id: "bad-base",
				repo: "agency",
				base: "absent-base",
				config: { version: 2 },
				expected:
					"Base 'absent-base' for repository 'agency' does not resolve to a commit",
			},
			{
				id: "failed-command",
				repo: "agency",
				base: "main",
				config: {
					version: 2,
					worktreeCreateCommand: [
						"sh",
						"-c",
						"echo command-failed >&2; exit 7",
						"{repo}",
						"{worktree}",
					],
				},
				expected: "Failed to create worktree for 'agency': command-failed",
			},
			{
				id: "missing-destination",
				repo: "agency",
				base: "main",
				config: {
					version: 2,
					worktreeCreateCommand: ["sh", "-c", "exit 0", "{repo}", "{worktree}"],
				},
				expected: "Worktree command did not create",
			},
		] as const

		for (const fixture of cases) {
			await Bun.write(join(root, "agency.json"), JSON.stringify(fixture.config))
			const taskDirectory = join(root, "tasks", fixture.id)
			await mkdir(taskDirectory, { recursive: true })
			await Bun.write(
				join(taskDirectory, "TASK.md"),
				`---
ticketUrl: https://example.com/tasks/${fixture.id}
repo: ${fixture.repo}
branch: task/${fixture.id}
base: ${fixture.base}
pr: null
---
`,
			)

			await expect(
				runTestEffect(
					WorktreeService.pipe(
						Effect.flatMap((service) =>
							service.materialize(fixture.id, undefined, root),
						),
					),
				),
			).rejects.toThrow(fixture.expected)
			await rm(taskDirectory, { recursive: true, force: true })
		}
	})

	test("compensates a custom command that fails after creating Git state", async () => {
		await Bun.write(
			join(root, "agency.json"),
			JSON.stringify({
				version: 2,
				worktreeCreateCommand: [
					"sh",
					"-c",
					'git -C "$1" worktree add -b "$3" "$2" "$4" >/dev/null 2>&1; exit 7',
					"agency-worktree",
					"{repo}",
					"{worktree}",
					"{branch}",
					"{base}",
				],
			}),
		)
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "compensated",
							ticketUrl: "https://example.com/task",
							repo: "agency",
							branch: "task/compensated",
							base: "main",
						},
						root,
					),
				),
			),
		)

		await expect(
			runTestEffect(
				WorktreeService.pipe(
					Effect.flatMap((service) =>
						service.materialize("compensated", undefined, root),
					),
				),
			),
		).rejects.toThrow("Failed to create worktree for 'agency'")
		expect(
			await Bun.file(join(root, "tasks/compensated/code/agency")).exists(),
		).toBe(false)
		expect(
			Bun.spawnSync([
				"git",
				"-C",
				join(root, "repos/agency"),
				"show-ref",
				"--verify",
				"refs/heads/task/compensated",
			]).exitCode,
		).not.toBe(0)
	})

	test("reports a planned hook in dry runs without executing it", async () => {
		const marker = join(root, "dry-run-hook")
		await Bun.write(
			join(root, "agency.json"),
			JSON.stringify({
				version: 2,
				repositories: {
					agency: {
						remote: "https://example.com/agency.git",
						postCheckoutCommand: ["sh", "-c", 'touch "$1"', "hook", marker],
					},
				},
			}),
		)
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "dry-hook",
							ticketUrl: null,
							repo: "agency",
							branch: "task/dry-hook",
							base: "main",
						},
						root,
					),
				),
			),
		)

		const materializeDry = () =>
			runTestEffect(
				WorktreeService.pipe(
					Effect.flatMap((service) =>
						service.materialize("dry-hook", undefined, root, {
							dryRun: true,
							verbose: true,
						}),
					),
				),
			)
		let workspace!: Awaited<ReturnType<typeof materializeDry>>
		const logs = await captureErrors(async () => {
			workspace = await materializeDry()
		})
		expect(workspace.operations).toContainEqual({
			action: "post-checkout",
			repo: "agency",
			command: ["sh", "-c", 'touch "$1"', "hook", marker],
			status: "planned",
		})
		expect(await Bun.file(marker).exists()).toBe(false)
		expect(await Bun.file(workspace.writablePath!).exists()).toBe(false)
		expect(logs).toEqual([
			expect.stringContaining("Planning post-checkout command for 'agency':"),
		])
	})

	test("rolls back a failed hook and runs it again on retry", async () => {
		const retryMarker = join(root, "retry-hook")
		await Bun.write(
			join(root, "agency.json"),
			JSON.stringify({
				version: 2,
				repositories: {
					agency: {
						remote: "https://example.com/agency.git",
						postCheckoutCommand: [
							"sh",
							"-c",
							'if [ ! -f "$1" ]; then touch partial-bootstrap "$1"; echo bootstrap-failed >&2; exit 7; fi',
							"hook",
							retryMarker,
						],
					},
				},
			}),
		)
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "retry-hook",
							ticketUrl: null,
							repo: "agency",
							branch: "task/retry-hook",
							base: "main",
						},
						root,
					),
				),
			),
		)
		const checkoutPath = join(root, "tasks/retry-hook/code/agency")

		await expect(
			runTestEffect(
				WorktreeService.pipe(
					Effect.flatMap((service) =>
						service.materialize("retry-hook", undefined, root),
					),
				),
			),
		).rejects.toThrow("bootstrap-failed")
		expect(await Bun.file(checkoutPath).exists()).toBe(false)
		expect(
			Bun.spawnSync([
				"git",
				"-C",
				join(root, "repos/agency"),
				"show-ref",
				"--verify",
				"refs/heads/task/retry-hook",
			]).exitCode,
		).not.toBe(0)

		await expect(
			runTestEffect(
				WorktreeService.pipe(
					Effect.flatMap((service) =>
						service.materialize("retry-hook", undefined, root),
					),
				),
			),
		).resolves.toMatchObject({ writablePath: checkoutPath })
	})

	test("does not run a hook when checkout validation fails", async () => {
		const marker = join(root, "invalid-checkout-hook")
		await Bun.write(
			join(root, "agency.json"),
			JSON.stringify({
				version: 2,
				worktreeCreateCommand: [
					"git",
					"-C",
					"{repo}",
					"worktree",
					"add",
					"--detach",
					"{worktree}",
					"{base}",
				],
				repositories: {
					agency: {
						remote: "https://example.com/agency.git",
						postCheckoutCommand: ["sh", "-c", 'touch "$1"', "hook", marker],
					},
				},
			}),
		)
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "invalid-hook-order",
							ticketUrl: null,
							repo: "agency",
							branch: "task/invalid-hook-order",
							base: "main",
						},
						root,
					),
				),
			),
		)

		await expect(
			runTestEffect(
				WorktreeService.pipe(
					Effect.flatMap((service) =>
						service.materialize("invalid-hook-order", undefined, root),
					),
				),
			),
		).rejects.toThrow("failed validation")
		expect(await Bun.file(marker).exists()).toBe(false)
	})

	test("rolls back when a hook executable cannot be started", async () => {
		await Bun.write(
			join(root, "agency.json"),
			JSON.stringify({
				version: 2,
				repositories: {
					agency: {
						remote: "https://example.com/agency.git",
						postCheckoutCommand: ["agency-missing-hook-executable"],
					},
				},
			}),
		)
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "missing-hook-command",
							ticketUrl: null,
							repo: "agency",
							branch: "task/missing-hook-command",
							base: "main",
						},
						root,
					),
				),
			),
		)
		const checkoutPath = join(root, "tasks/missing-hook-command/code/agency")

		await expect(
			runTestEffect(
				WorktreeService.pipe(
					Effect.flatMap((service) =>
						service.materialize("missing-hook-command", undefined, root),
					),
				),
			),
		).rejects.toThrow("Failed to start post-checkout command for 'agency'")
		expect(await Bun.file(checkoutPath).exists()).toBe(false)
	})

	test("moves and repairs an existing worktree when converting a task", async () => {
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "promoted",
							ticketUrl: "https://example.com/task",
							repo: "agency",
							branch: "task/promoted",
							base: "main",
						},
						root,
					),
				),
			),
		)
		const originalWorkspace = await runTestEffect(
			WorktreeService.pipe(
				Effect.flatMap((service) =>
					service.materialize("promoted", undefined, root),
				),
			),
		)

		await runTestEffect(
			PhaseService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							taskId: "promoted",
							id: "follow-up",
							firstPhase: "implementation",
							repo: "agency",
							branch: "task/follow-up",
							base: "main",
						},
						root,
					),
				),
			),
		)

		expect(
			await Bun.file(
				join(originalWorkspace.writablePath!, "README.md"),
			).exists(),
		).toBe(false)
		const movedWorkspace = await runTestEffect(
			WorktreeService.pipe(
				Effect.flatMap((service) =>
					service.materialize("promoted", "implementation", root),
				),
			),
		)
		expect(movedWorkspace.writablePath).toBe(
			join(root, "tasks/promoted/phases/implementation/code/agency"),
		)
		expect(
			await Bun.file(join(movedWorkspace.writablePath!, "README.md")).text(),
		).toBe("example\n")
		const status = Bun.spawnSync(
			["git", "-C", movedWorkspace.writablePath!, "status", "--porcelain"],
			{ stdout: "pipe", stderr: "pipe" },
		)
		expect(status.exitCode).toBe(0)
	})

	test("preflights worktree registration before converting a task", async () => {
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "unregistered",
							ticketUrl: null,
							repo: "agency",
							branch: "task/unregistered",
							base: "main",
						},
						root,
					),
				),
			),
		)
		const checkout = join(root, "tasks/unregistered/code/agency")
		await mkdir(checkout, { recursive: true })
		await Bun.write(join(checkout, "keep.txt"), "keep\n")

		await expect(
			runTestEffect(
				PhaseService.pipe(
					Effect.flatMap((service) =>
						service.create(
							{
								taskId: "unregistered",
								id: "follow-up",
								firstPhase: "implementation",
								repo: "agency",
								branch: "task/follow-up-unregistered",
								base: "main",
							},
							root,
						),
					),
				),
			),
		).rejects.toThrow("is not registered as a Git worktree")
		expect(await Bun.file(join(checkout, "keep.txt")).text()).toBe("keep\n")
		expect(
			await Bun.file(
				join(root, "tasks/unregistered/phases/implementation/PHASE.md"),
			).exists(),
		).toBe(false)
	})

	test("rejects a writable branch checked out in another worktree", async () => {
		const repository = join(root, "repos/agency")
		await git(["-C", repository, "branch", "task/shared", "main"])
		const outside = join(root, "outside")
		await git(["-C", repository, "worktree", "add", outside, "task/shared"])
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "conflict",
							ticketUrl: "https://example.com/task",
							repo: "agency",
							branch: "task/shared",
							base: "main",
						},
						root,
					),
				),
			),
		)

		await expect(
			runTestEffect(
				WorktreeService.pipe(
					Effect.flatMap((service) =>
						service.materialize("conflict", undefined, root),
					),
				),
			),
		).rejects.toThrow("already checked out at")
	})

	test("rejects duplicate Agency ownership before materializing", async () => {
		for (const id of ["first-owner", "second-owner"]) {
			await runTestEffect(
				TaskService.pipe(
					Effect.flatMap((service) =>
						service.create(
							{
								id,
								ticketUrl: `https://example.com/${id}`,
								repo: "agency",
								branch: "task/shared-owner",
								base: "main",
							},
							root,
						),
					),
				),
			)
		}

		await expect(
			runTestEffect(
				WorktreeService.pipe(
					Effect.flatMap((service) =>
						service.materialize("first-owner", undefined, root),
					),
				),
			),
		).rejects.toThrow("also owned by tasks/first-owner/TASK.md")
	})

	test("rejects an existing Agency checkout on the wrong branch", async () => {
		const repository = join(root, "repos/agency")
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "wrong",
							ticketUrl: "https://example.com/task",
							repo: "agency",
							branch: "task/expected",
							base: "main",
						},
						root,
					),
				),
			),
		)
		await git(["-C", repository, "branch", "task/wrong", "main"])
		const checkout = join(root, "tasks/wrong/code/agency")
		await mkdir(join(root, "tasks/wrong/code"), { recursive: true })
		await git(["-C", repository, "worktree", "add", checkout, "task/wrong"])

		await expect(
			runTestEffect(
				WorktreeService.pipe(
					Effect.flatMap((service) =>
						service.materialize("wrong", undefined, root),
					),
				),
			),
		).rejects.toThrow("is not registered to branch 'task/expected'")
	})

	test("fetches a moving ref before checking a reused reference checkout", async () => {
		await ensureEffectRepository()
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "pinned-reference",
							ticketUrl: "https://example.com/task",
							repo: "agency",
							repos: [{ repo: "effect", ref: "origin/main" }],
							branch: "task/pinned-reference",
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
					service.materialize("pinned-reference", undefined, root),
				),
			),
		)

		await Bun.write(join(source, "README.md"), "updated\n")
		await git(["add", "README.md"], source)
		await git(["-c", "commit.gpgsign=false", "commit", "-m", "update"], source)

		await expect(
			runTestEffect(
				WorktreeService.pipe(
					Effect.flatMap((service) =>
						service.materialize("pinned-reference", undefined, root),
					),
				),
			),
		).rejects.toThrow("does not match reference 'origin/main'")
	})

	test("rejects a reference checkout attached to a branch", async () => {
		await ensureEffectRepository()
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "attached-reference",
							ticketUrl: "https://example.com/task",
							repo: "agency",
							repos: [{ repo: "effect", ref: "main" }],
							branch: "task/attached-reference",
							base: "main",
						},
						root,
					),
				),
			),
		)
		const checkout = join(root, "tasks/attached-reference/code/effect")
		await mkdir(join(root, "tasks/attached-reference/code"), {
			recursive: true,
		})
		await git([
			"-C",
			join(root, "repos/effect"),
			"worktree",
			"add",
			checkout,
			"main",
		])

		await expect(
			runTestEffect(
				WorktreeService.pipe(
					Effect.flatMap((service) =>
						service.materialize("attached-reference", undefined, root),
					),
				),
			),
		).rejects.toThrow("is attached to branch 'main'")
		expect(
			await Bun.file(
				join(root, "tasks/attached-reference/code/agency"),
			).exists(),
		).toBe(false)
		expect(
			Bun.spawnSync([
				"git",
				"-C",
				join(root, "repos/agency"),
				"show-ref",
				"--verify",
				"refs/heads/task/attached-reference",
			]).exitCode,
		).not.toBe(0)
	})

	test("removes worktrees without deleting branches", async () => {
		await ensureEffectRepository()
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "removable",
							ticketUrl: "https://example.com/task",
							repo: "agency",
							repos: [{ repo: "effect", ref: "main" }],
							branch: "task/removable",
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
					service.materialize("removable", undefined, root),
				),
			),
		)

		const removed = await runTestEffect(
			WorktreeService.pipe(
				Effect.flatMap((service) =>
					service.remove("removable", undefined, root),
				),
			),
		)

		expect(removed.sort()).toEqual(
			[
				join(workspace.codePath, "agency"),
				join(workspace.codePath, "effect"),
			].sort(),
		)
		expect(await Bun.file(workspace.codePath).exists()).toBe(false)
		const branch = Bun.spawnSync([
			"git",
			"-C",
			join(root, "repos/agency"),
			"show-ref",
			"--verify",
			"refs/heads/task/removable",
		])
		expect(branch.exitCode).toBe(0)
		expect(workspace.checkouts).toEqual([
			expect.objectContaining({
				repo: "agency",
				kind: "writable",
				action: "created",
				resolvedCommit: expect.stringMatching(/^[0-9a-f]{40}$/),
			}),
			expect.objectContaining({
				repo: "effect",
				kind: "reference",
				action: "created",
				resolvedCommit: expect.stringMatching(/^[0-9a-f]{40}$/),
			}),
		])
	})

	test("reports dry-run fetch and worktree changes without mutating", async () => {
		await ensureEffectRepository()
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "planned",
							ticketUrl: "https://example.com/task",
							repo: "agency",
							repos: [{ repo: "effect", ref: "main" }],
							branch: "task/planned",
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
					service.materialize("planned", undefined, root, { dryRun: true }),
				),
			),
		)

		expect(workspace.dryRun).toBe(true)
		expect(
			workspace.checkouts.every(({ resolvedCommit }) => resolvedCommit),
		).toBe(true)
		expect(
			workspace.checkouts.map(({ repo, action }) => ({ repo, action })),
		).toEqual([
			{ repo: "agency", action: "created" },
			{ repo: "effect", action: "created" },
		])
		expect(workspace.operations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ action: "fetch", status: "planned" }),
				expect.objectContaining({
					action: "create-worktree",
					status: "planned",
				}),
			]),
		)
		expect(await Bun.file(workspace.codePath).exists()).toBe(false)
		expect(
			Bun.spawnSync([
				"git",
				"-C",
				join(root, "repos/agency"),
				"show-ref",
				"--verify",
				"refs/heads/task/planned",
			]).exitCode,
		).not.toBe(0)
	})

	test("dry-run resolves a reference that exists only on the remote", async () => {
		await ensureEffectRepository()
		await git(["checkout", "-b", "remote-only"], source)
		await Bun.write(join(source, "remote.txt"), "remote\n")
		await git(["add", "remote.txt"], source)
		await git(
			["-c", "commit.gpgsign=false", "commit", "-m", "remote branch"],
			source,
		)
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "remote-reference",
							ticketUrl: null,
							repo: "agency",
							repos: [{ repo: "effect", ref: "remote-only" }],
							branch: "task/remote-reference",
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
					service.materialize("remote-reference", undefined, root, {
						dryRun: true,
					}),
				),
			),
		)
		expect(
			workspace.checkouts.find((checkout) => checkout.repo === "effect")
				?.resolvedCommit,
		).toMatch(/^[0-9a-f]{40}$/)
		expect(
			Bun.spawnSync([
				"git",
				"-C",
				join(root, "repos/effect"),
				"show-ref",
				"--verify",
				"refs/heads/remote-only",
			]).exitCode,
		).not.toBe(0)
	})

	test("refuses to remove a worktree with uncommitted changes", async () => {
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "dirty",
							ticketUrl: "https://example.com/task",
							repo: "agency",
							branch: "task/dirty",
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
					service.materialize("dirty", undefined, root),
				),
			),
		)
		await Bun.write(
			join(workspace.writablePath!, "uncommitted.txt"),
			"keep me\n",
		)

		await expect(
			runTestEffect(
				WorktreeService.pipe(
					Effect.flatMap((service) => service.remove("dirty", undefined, root)),
				),
			),
		).rejects.toThrow("Failed to remove worktree for 'agency'")
		expect(
			await Bun.file(join(workspace.writablePath!, "uncommitted.txt")).text(),
		).toBe("keep me\n")
	})

	test("handles a missing checkout without deleting its branch", async () => {
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "stale",
							ticketUrl: "https://example.com/task",
							repo: "agency",
							branch: "task/stale",
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
		await rm(workspace.codePath, { recursive: true })

		const removed = await runTestEffect(
			WorktreeService.pipe(
				Effect.flatMap((service) => service.remove("stale", undefined, root)),
			),
		)

		expect(removed).toHaveLength(1)
		expect(removed[0]).toEndWith("/tasks/stale/code/agency")
		const worktrees = Bun.spawnSync([
			"git",
			"-C",
			join(root, "repos/agency"),
			"worktree",
			"list",
			"--porcelain",
		])
		expect(new TextDecoder().decode(worktrees.stdout)).not.toContain(
			workspace.writablePath!,
		)
		expect(
			Bun.spawnSync([
				"git",
				"-C",
				join(root, "repos/agency"),
				"show-ref",
				"--verify",
				"refs/heads/task/stale",
			]).exitCode,
		).toBe(0)
	})

	test("lists and inspects ownership, registration, commits, and dirtiness", async () => {
		const repository = join(root, "repos/agency")
		await git(["-C", repository, "branch", "task/inspected", "main"])
		const outside = join(root, "outside-inspected")
		await git(["-C", repository, "worktree", "add", outside, "task/inspected"])
		await Bun.write(join(outside, "dirty.txt"), "keep\n")
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "inspected",
							ticketUrl: null,
							repo: "agency",
							branch: "task/inspected",
							base: "main",
						},
						root,
					),
				),
			),
		)

		const inspections = await runTestEffect(
			WorktreeService.pipe(Effect.flatMap((service) => service.list(root))),
		)
		const inspection = inspections.find(
			({ owner }) => owner.taskId === "inspected",
		)!
		const checkout = inspection.checkouts[0]!
		expect(inspection.owner).toMatchObject({
			kind: "task",
			taskId: "inspected",
			documentPath: join(root, "tasks/inspected/TASK.md"),
		})
		const registeredOutside = await realpath(outside)
		expect(checkout).toMatchObject({
			registeredPath: registeredOutside,
			actualBranch: "task/inspected",
			actualCommit: expect.stringMatching(/^[0-9a-f]{40}$/),
			dirty: true,
		})
		expect(checkout.conflicts).toContainEqual(
			expect.objectContaining({
				kind: "branch-conflict",
				registeredPath: registeredOutside,
				branch: "task/inspected",
				commit: expect.stringMatching(/^[0-9a-f]{40}$/),
				dirty: true,
			}),
		)
	})

	test("refuses to remove a clean checkout owned by the wrong branch", async () => {
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "remove-wrong",
							ticketUrl: null,
							repo: "agency",
							branch: "task/expected-remove",
							base: "main",
						},
						root,
					),
				),
			),
		)
		const repository = join(root, "repos/agency")
		await git(["-C", repository, "branch", "task/actual-remove", "main"])
		const checkout = join(root, "tasks/remove-wrong/code/agency")
		await mkdir(join(root, "tasks/remove-wrong/code"), { recursive: true })
		await git([
			"-C",
			repository,
			"worktree",
			"add",
			checkout,
			"task/actual-remove",
		])

		await expect(
			runTestEffect(
				WorktreeService.pipe(
					Effect.flatMap((service) =>
						service.remove("remove-wrong", undefined, root),
					),
				),
			),
		).rejects.toThrow("not branch 'task/expected-remove'")
		expect(await Bun.file(join(checkout, "README.md")).exists()).toBe(true)
	})

	test("does not delete a non-worktree entry named for an expected alias", async () => {
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "unexpected-file",
							ticketUrl: null,
							repo: "agency",
							branch: "task/unexpected-file",
							base: "main",
						},
						root,
					),
				),
			),
		)
		const codePath = join(root, "tasks/unexpected-file/code")
		const unexpected = join(codePath, "agency")
		await mkdir(codePath, { recursive: true })
		await Bun.write(unexpected, "keep me\n")

		await expect(
			runTestEffect(
				WorktreeService.pipe(
					Effect.flatMap((service) =>
						service.remove("unexpected-file", undefined, root),
					),
				),
			),
		).rejects.toThrow("is not a directory")
		expect(await Bun.file(unexpected).text()).toBe("keep me\n")
	})

	test("refuses removal when a branch has duplicate Agency owners", async () => {
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "owned-removal",
							ticketUrl: null,
							repo: "agency",
							branch: "task/owned-removal",
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
					service.materialize("owned-removal", undefined, root),
				),
			),
		)
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "other-owner",
							ticketUrl: null,
							repo: "agency",
							branch: "task/owned-removal",
							base: "main",
						},
						root,
					),
				),
			),
		)

		await expect(
			runTestEffect(
				WorktreeService.pipe(
					Effect.flatMap((service) =>
						service.remove("owned-removal", undefined, root),
					),
				),
			),
		).rejects.toThrow("multiple Agency owners")
		expect(
			await Bun.file(join(workspace.writablePath!, "README.md")).exists(),
		).toBe(true)
	})

	test("dry-runs and rebuilds every clean declared checkout", async () => {
		await ensureEffectRepository()
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "rebuilt",
							ticketUrl: null,
							repo: "agency",
							repos: [{ repo: "effect", ref: "main" }],
							branch: "task/rebuilt",
							base: "main",
						},
						root,
					),
				),
			),
		)
		const original = await runTestEffect(
			WorktreeService.pipe(
				Effect.flatMap((service) =>
					service.materialize("rebuilt", undefined, root),
				),
			),
		)
		const plan = await runTestEffect(
			WorktreeService.pipe(
				Effect.flatMap((service) =>
					service.rebuild("rebuilt", undefined, root, { dryRun: true }),
				),
			),
		)
		expect(plan.actions).toEqual(
			expect.arrayContaining([
				`remove ${join(original.codePath, "agency")}`,
				`create ${join(original.codePath, "agency")}`,
				`remove ${join(original.codePath, "effect")}`,
				`create ${join(original.codePath, "effect")}`,
			]),
		)
		expect(
			await Bun.file(join(original.writablePath!, "README.md")).exists(),
		).toBe(true)

		const rebuilt = await runTestEffect(
			WorktreeService.pipe(
				Effect.flatMap((service) =>
					service.rebuild("rebuilt", undefined, root),
				),
			),
		)
		expect(rebuilt.inspection.conflicts).toEqual([])
		expect(
			await Bun.file(join(original.writablePath!, "README.md")).exists(),
		).toBe(true)
	})

	test("rebuilds clean drifted jj references without discarding changes", async () => {
		if (!Bun.which("jj")) return
		const first = new TextDecoder()
			.decode(
				Bun.spawnSync(["git", "-C", source, "rev-parse", "HEAD"], {
					stdout: "pipe",
				}).stdout,
			)
			.trim()
		await Bun.write(join(source, "README.md"), "updated\n")
		await git(["add", "README.md"], source)
		await git(["-c", "commit.gpgsign=false", "commit", "-m", "update"], source)
		const second = new TextDecoder()
			.decode(
				Bun.spawnSync(["git", "-C", source, "rev-parse", "HEAD"], {
					stdout: "pipe",
				}).stdout,
			)
			.trim()
		const repository = join(root, "repos/agency")
		await rm(repository, { recursive: true, force: true })
		await jj(["git", "clone", "--no-colocate", source, repository])
		await Bun.write(
			join(root, "agency.json"),
			JSON.stringify({ version: 2, vcs: "jj" }),
		)
		const createDriftedReview = async (id: string) => {
			const task = await runTestEffect(
				TaskService.pipe(
					Effect.flatMap((service) =>
						service.create(
							{
								id,
								ticketUrl: null,
								review: {
									repo: "agency",
									source: {
										kind: "branch",
										ref: "refs/heads/main",
									},
									commit: first,
									refreshedAt: "2026-08-10T00:00:00.000Z",
								},
							},
							root,
						),
					),
				),
			)
			const workspace = await runTestEffect(
				WorktreeService.pipe(
					Effect.flatMap((service) => service.materialize(id, undefined, root)),
				),
			)
			await Bun.write(task.path, task.content.replace(first, second))
			return workspace
		}

		const workspace = await createDriftedReview("drifted-review")

		await expect(
			runTestEffect(
				WorktreeService.pipe(
					Effect.flatMap((service) =>
						service.materialize("drifted-review", undefined, root),
					),
				),
			),
		).rejects.toThrow("does not match reference")
		const inspection = await runTestEffect(
			WorktreeService.pipe(
				Effect.flatMap((service) =>
					service.inspect("drifted-review", undefined, root),
				),
			),
		)
		expect(inspection.conflicts).toEqual([
			expect.objectContaining({ kind: "reference-drift" }),
		])
		await runTestEffect(
			WorktreeService.pipe(
				Effect.flatMap((service) =>
					service.rebuild("drifted-review", undefined, root),
				),
			),
		)
		expect(
			await Bun.file(join(workspace.reviewPath!, "README.md")).text(),
		).toBe("updated\n")

		const dirtyWorkspace = await createDriftedReview("dirty-drifted-review")
		const dirtyPath = join(dirtyWorkspace.reviewPath!, "dirty.txt")
		await Bun.write(dirtyPath, "preserve me\n")
		await expect(
			runTestEffect(
				WorktreeService.pipe(
					Effect.flatMap((service) =>
						service.rebuild("dirty-drifted-review", undefined, root),
					),
				),
			),
		).rejects.toThrow("checkout has uncommitted changes")
		expect(await Bun.file(dirtyPath).text()).toBe("preserve me\n")
	})

	test("restores removed worktrees when rebuild creation fails", async () => {
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "rebuild-rollback",
							ticketUrl: null,
							repo: "agency",
							branch: "task/rebuild-rollback",
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
					service.materialize("rebuild-rollback", undefined, root),
				),
			),
		)
		await Bun.write(
			join(root, "agency.json"),
			JSON.stringify({
				version: 2,
				worktreeCreateCommand: [
					"sh",
					"-c",
					"echo rebuild-failed >&2; exit 7",
					"{repo}",
					"{worktree}",
				],
			}),
		)

		await expect(
			runTestEffect(
				WorktreeService.pipe(
					Effect.flatMap((service) =>
						service.rebuild("rebuild-rollback", undefined, root),
					),
				),
			),
		).rejects.toThrow("original worktrees were restored")
		expect(
			await Bun.file(join(workspace.writablePath!, "README.md")).exists(),
		).toBe(true)
	})

	test("repairs a stale registration without deleting the writable branch", async () => {
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "repaired",
							ticketUrl: null,
							repo: "agency",
							branch: "task/repaired",
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
					service.materialize("repaired", undefined, root),
				),
			),
		)
		await rm(workspace.codePath, { recursive: true })

		const plan = await runTestEffect(
			WorktreeService.pipe(
				Effect.flatMap((service) =>
					service.repair("repaired", undefined, root, { dryRun: true }),
				),
			),
		)
		expect(plan.actions.join("\n")).toContain("worktree prune --expire now")
		expect(plan.actions).toContain(`prepare ${workspace.writablePath!}`)

		const repaired = await runTestEffect(
			WorktreeService.pipe(
				Effect.flatMap((service) =>
					service.repair("repaired", undefined, root),
				),
			),
		)
		expect(repaired.inspection.conflicts).toEqual([])
		expect(
			await Bun.file(join(workspace.writablePath!, "README.md")).exists(),
		).toBe(true)
		expect(
			Bun.spawnSync([
				"git",
				"-C",
				join(root, "repos/agency"),
				"show-ref",
				"--verify",
				"refs/heads/task/repaired",
			]).exitCode,
		).toBe(0)
	})

	test("refuses to repair an unregistered checkout on the wrong branch", async () => {
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "repair-wrong",
							ticketUrl: null,
							repo: "agency",
							branch: "task/repair-expected",
							base: "main",
						},
						root,
					),
				),
			),
		)
		const repository = join(root, "repos/agency")
		await git(["-C", repository, "branch", "task/repair-actual", "main"])
		const oldPath = join(root, "repair-old-path")
		const checkout = join(root, "tasks/repair-wrong/code/agency")
		await git([
			"-C",
			repository,
			"worktree",
			"add",
			oldPath,
			"task/repair-actual",
		])
		await mkdir(join(root, "tasks/repair-wrong/code"), { recursive: true })
		await rename(oldPath, checkout)
		await Bun.write(join(checkout, "uncommitted.txt"), "keep me\n")

		await expect(
			runTestEffect(
				WorktreeService.pipe(
					Effect.flatMap((service) =>
						service.repair("repair-wrong", undefined, root),
					),
				),
			),
		).rejects.toThrow("not branch 'task/repair-expected'")
		expect(await Bun.file(join(checkout, "uncommitted.txt")).text()).toBe(
			"keep me\n",
		)
	})

	test("repairs a moved checkout without changing its branch or dirty files", async () => {
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "repair-moved",
							ticketUrl: null,
							repo: "agency",
							branch: "task/repair-moved",
							base: "main",
						},
						root,
					),
				),
			),
		)
		const repository = join(root, "repos/agency")
		await git(["-C", repository, "branch", "task/repair-moved", "main"])
		const oldPath = join(root, "repair-moved-old")
		const checkout = join(root, "tasks/repair-moved/code/agency")
		await git([
			"-C",
			repository,
			"worktree",
			"add",
			oldPath,
			"task/repair-moved",
		])
		await mkdir(join(root, "tasks/repair-moved/code"), { recursive: true })
		await rename(oldPath, checkout)
		await Bun.write(join(checkout, "uncommitted.txt"), "keep me\n")

		const repaired = await runTestEffect(
			WorktreeService.pipe(
				Effect.flatMap((service) =>
					service.repair("repair-moved", undefined, root),
				),
			),
		)
		expect(repaired.inspection.conflicts).toEqual([])
		expect(repaired.inspection.checkouts[0]).toMatchObject({
			actualBranch: "task/repair-moved",
			dirty: true,
			registered: true,
		})
		expect(await Bun.file(join(checkout, "uncommitted.txt")).text()).toBe(
			"keep me\n",
		)
	})

	test("supports Worktrunk as the configured command", async () => {
		if (Bun.spawnSync(["which", "wt"], { stdout: "ignore" }).exitCode !== 0) {
			return
		}

		await Bun.write(
			join(root, "agency.json"),
			JSON.stringify({
				version: 2,
				worktreeCreateCommand: [
					"wt",
					"-C",
					"{repo}",
					"-y",
					"--config-set",
					'worktree-path="{worktree}"',
					"switch",
					"--create",
					"--base",
					"{base}",
					"{branch}",
					"--no-cd",
					"--format",
					"json",
				],
			}),
		)
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "worktrunk",
							ticketUrl: "https://example.com/task",
							repo: "agency",
							branch: "task/worktrunk",
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
					service.materialize("worktrunk", undefined, root),
				),
			),
		)
		expect(
			await Bun.file(join(workspace.writablePath!, "README.md")).text(),
		).toBe("example\n")
	})
})
