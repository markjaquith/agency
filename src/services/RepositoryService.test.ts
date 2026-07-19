import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { cleanupTempDir, createTempDir, runTestEffect } from "../test-utils"
import { RepositoryService } from "./RepositoryService"

const runGit = async (args: string[]) => {
	const process = Bun.spawn(["git", ...args], {
		stdout: "pipe",
		stderr: "pipe",
	})
	await process.exited
	if (process.exitCode !== 0) {
		throw new Error(await new Response(process.stderr).text())
	}
}

const portableRemote = (name: string) =>
	`https://example.com/agency-tests/${name}.git`

const setPortableOrigin = (path: string, name: string) =>
	runGit(["-C", path, "remote", "add", "origin", portableRemote(name)])

const startGitDaemon = async (basePath: string) => {
	const port = 20000 + Math.floor(Math.random() * 20000)
	const process = Bun.spawn(
		[
			"git",
			"daemon",
			"--reuseaddr",
			"--export-all",
			`--base-path=${basePath}`,
			"--listen=127.0.0.1",
			`--port=${port}`,
			basePath,
		],
		{ stdout: "pipe", stderr: "pipe" },
	)
	const remote = `git://127.0.0.1:${port}/source.git`
	for (let attempt = 0; attempt < 40; attempt++) {
		const probe = Bun.spawn(["git", "ls-remote", remote], {
			stdout: "ignore",
			stderr: "ignore",
		})
		if ((await probe.exited) === 0) return { process, remote }
		await Bun.sleep(25)
	}
	process.kill()
	throw new Error("Git daemon did not start")
}

const write = async (root: string, path: string, content: string) => {
	const fullPath = join(root, path)
	await mkdir(dirname(fullPath), { recursive: true })
	await Bun.write(fullPath, content)
}

describe("RepositoryService", () => {
	let root: string

	beforeEach(async () => {
		root = await createTempDir()
		await Bun.write(join(root, "agency.json"), '{"version":2}\n')
	})

	afterEach(async () => {
		await cleanupTempDir(root)
	})

	test("adds a bare repository from a remote", async () => {
		const source = join(root, "source.git")
		await runGit(["init", "--bare", "--initial-branch=main", source])
		await setPortableOrigin(source, "agency")

		const destination = await runTestEffect(
			RepositoryService.pipe(
				Effect.flatMap((service) => service.add("agency", "source.git", root)),
			),
		)

		expect(destination).toBe(join(root, "repos/agency"))
		expect(await Bun.file(join(destination, "HEAD")).exists()).toBe(true)

		const repositories = await runTestEffect(
			RepositoryService.pipe(Effect.flatMap((service) => service.list(root))),
		)
		expect(repositories).toEqual([
			{
				alias: "agency",
				path: destination,
				kind: "bare",
				remote: portableRemote("agency"),
				declaredRemote: portableRemote("agency"),
				target: null,
				states: ["declared", "materialized"],
			},
		])
	})

	test("links an existing repository", async () => {
		const target = join(root, "linked-repository")
		await mkdir(target, { recursive: true })
		await runGit(["init", "--initial-branch=main", target])
		await setPortableOrigin(target, "effect")

		const destination = await runTestEffect(
			RepositoryService.pipe(
				Effect.flatMap((service) => service.link("effect", target, root)),
			),
		)

		const repositories = await runTestEffect(
			RepositoryService.pipe(Effect.flatMap((service) => service.list(root))),
		)
		expect(repositories[0]).toEqual({
			alias: "effect",
			path: destination,
			kind: "symlink",
			remote: portableRemote("effect"),
			declaredRemote: portableRemote("effect"),
			target,
			states: ["declared", "linked"],
		})
	})

	test("rejects invalid and duplicate aliases", async () => {
		const source = join(root, "source.git")
		await runGit(["init", "--bare", "--initial-branch=main", source])
		await setPortableOrigin(source, "duplicate")

		await expect(
			runTestEffect(
				RepositoryService.pipe(
					Effect.flatMap((service) => service.add("bad/alias", source, root)),
				),
			),
		).rejects.toThrow("Invalid repository alias")

		await runTestEffect(
			RepositoryService.pipe(
				Effect.flatMap((service) => service.add("agency", source, root)),
			),
		)
		await expect(
			runTestEffect(
				RepositoryService.pipe(
					Effect.flatMap((service) => service.add("agency", source, root)),
				),
			),
		).rejects.toThrow("already exists")
	})

	test("leaves no declaration or materialization when cloning fails", async () => {
		await expect(
			runTestEffect(
				RepositoryService.pipe(
					Effect.flatMap((service) =>
						service.add("failed", "git://127.0.0.1:1/missing.git", root),
					),
				),
			),
		).rejects.toThrow("Failed to clone repository")
		expect(await Bun.file(join(root, "agency.json")).json()).toEqual({
			version: 2,
		})
		expect(await Bun.file(join(root, "repos/failed")).exists()).toBe(false)
	})

	test("rolls back a repository move when config installation fails", async () => {
		const source = join(root, "source.git")
		await runGit(["init", "--bare", "--initial-branch=main", source])
		await setPortableOrigin(source, "rollback")
		await runTestEffect(
			RepositoryService.pipe(
				Effect.flatMap((service) => service.add("old", source, root)),
			),
		)
		const configBefore = await Bun.file(join(root, "agency.json")).text()
		const originalWrite = Bun.write
		;(Bun as { write: typeof Bun.write }).write = ((
			destination: unknown,
			data: unknown,
		) =>
			String(destination).includes(".agency-transaction-")
				? Promise.reject(new Error("injected config write failure"))
				: originalWrite(
						destination as never,
						data as never,
					)) as typeof Bun.write

		try {
			await expect(
				runTestEffect(
					RepositoryService.pipe(
						Effect.flatMap((service) => service.rename("old", "new", root)),
					),
				),
			).rejects.toThrow("completed changes were rolled back")
		} finally {
			;(Bun as { write: typeof Bun.write }).write = originalWrite
		}

		expect(await Bun.file(join(root, "repos/old/HEAD")).exists()).toBe(true)
		expect(await Bun.file(join(root, "repos/new/HEAD")).exists()).toBe(false)
		expect(await Bun.file(join(root, "agency.json")).text()).toBe(configBefore)
		expect(
			(await Array.fromAsync(new Bun.Glob(".agency-*").scan(root))).length,
		).toBe(0)
	})

	test("reports a file collision as invalid setup state", async () => {
		await Bun.write(
			join(root, "agency.json"),
			JSON.stringify({
				version: 2,
				repositories: {
					blocked: { remote: portableRemote("blocked") },
				},
			}),
		)
		await mkdir(join(root, "repos"), { recursive: true })
		await Bun.write(join(root, "repos/blocked"), "not a repository")

		const setup = await runTestEffect(
			RepositoryService.pipe(
				Effect.flatMap((service) => service.setup({ cwd: root })),
			),
		)

		expect(setup.actions).toEqual([])
		expect(setup.repositories[0]?.states).toEqual(["declared", "invalid"])
		expect(setup.unresolved[0]).toMatchObject({
			alias: "blocked",
			state: "invalid",
		})
	})

	test("shows, fetches, updates, and verifies a repository", async () => {
		const source = join(root, "source")
		const replacement = portableRemote("replacement")
		await runGit(["init", "--initial-branch=main", source])
		await setPortableOrigin(source, "source")
		await Bun.write(join(source, "README.md"), "# Source\n")
		await runGit(["-C", source, "add", "README.md"])
		await runGit([
			"-C",
			source,
			"-c",
			"user.name=Agency Tests",
			"-c",
			"user.email=agency@example.com",
			"commit",
			"-m",
			"Initial commit",
		])
		await runTestEffect(
			RepositoryService.pipe(
				Effect.flatMap((service) => service.add("agency", source, root)),
			),
		)
		await runGit([
			"-C",
			join(root, "repos/agency"),
			"config",
			`url.${source}.insteadOf`,
			portableRemote("source"),
		])

		const result = await runTestEffect(
			RepositoryService.pipe(
				Effect.flatMap((service) =>
					Effect.gen(function* () {
						const shown = yield* service.show("agency", root)
						yield* service.fetch("agency", root)
						const updated = yield* service.remote("agency", replacement, root)
						const verified = yield* service.verify("agency", root)
						return { shown, updated, verified }
					}),
				),
			),
		)

		expect(result.shown.remote).toBe(source)
		expect(result.shown.declaredRemote).toBe(portableRemote("source"))
		expect(result.updated.remote).toBe(replacement)
		expect(result.verified.valid).toBe(true)
		expect(result.verified.issues).toEqual([])
	})

	test("renames and removes an unused repository", async () => {
		const source = join(root, "source.git")
		await runGit(["init", "--bare", "--initial-branch=main", source])
		await setPortableOrigin(source, "rename")
		await runTestEffect(
			RepositoryService.pipe(
				Effect.flatMap((service) => service.add("old", source, root)),
			),
		)

		const removed = await runTestEffect(
			RepositoryService.pipe(
				Effect.flatMap((service) =>
					Effect.gen(function* () {
						const renamed = yield* service.rename("old", "new", root)
						expect(renamed.alias).toBe("new")
						return yield* service.remove("new", root)
					}),
				),
			),
		)

		expect(removed.alias).toBe("new")
		expect(await Bun.file(join(root, "repos/new/HEAD")).exists()).toBe(false)
	})

	test("unlinks a symlink without deleting its target", async () => {
		const target = join(root, "linked-repository")
		await mkdir(target, { recursive: true })
		await runGit(["init", "--initial-branch=main", target])
		await setPortableOrigin(target, "linked")
		await runTestEffect(
			RepositoryService.pipe(
				Effect.flatMap((service) => service.link("linked", target, root)),
			),
		)

		await runTestEffect(
			RepositoryService.pipe(
				Effect.flatMap((service) => service.unlink("linked", root)),
			),
		)

		expect(await Bun.file(join(target, ".git/HEAD")).exists()).toBe(true)
		expect(await Bun.file(join(root, "repos/linked/.git/HEAD")).exists()).toBe(
			false,
		)
		const declared = await runTestEffect(
			RepositoryService.pipe(
				Effect.flatMap((service) => service.show("linked", root)),
			),
		)
		expect(declared.states).toEqual(["declared", "missing"])
	})

	test("refuses to unlink an alias with active references", async () => {
		const target = join(root, "referenced-link")
		await mkdir(target, { recursive: true })
		await runGit(["init", "--initial-branch=main", target])
		await setPortableOrigin(target, "referenced-link")
		await runTestEffect(
			RepositoryService.pipe(
				Effect.flatMap((service) => service.link("linked", target, root)),
			),
		)
		await write(
			root,
			"tasks/active/TASK.md",
			`---
ticketUrl: null
repo: linked
branch: task/active-link
base: main
pr: null
---
`,
		)

		await expect(
			runTestEffect(
				RepositoryService.pipe(
					Effect.flatMap((service) => service.unlink("linked", root)),
				),
			),
		).rejects.toThrow("active reference execution-unit:task/active")
		expect(await Bun.file(join(root, "repos/linked/.git/HEAD")).exists()).toBe(
			true,
		)
	})

	test("replaces an unused managed clone with a linked checkout", async () => {
		const source = join(root, "source.git")
		const target = join(root, "local-checkout")
		await runGit(["init", "--bare", "--initial-branch=main", source])
		await setPortableOrigin(source, "replace")
		await mkdir(target, { recursive: true })
		await runGit(["init", "--initial-branch=main", target])

		const linked = await runTestEffect(
			RepositoryService.pipe(
				Effect.flatMap((service) =>
					Effect.gen(function* () {
						yield* service.add("agency", source, root)
						yield* service.link("agency", target, root)
						return yield* service.show("agency", root)
					}),
				),
			),
		)

		expect(linked.kind).toBe("symlink")
		expect(linked.target).toBe(target)
		expect(linked.declaredRemote).toBe(portableRemote("replace"))
		expect(linked.states).toEqual(["declared", "linked", "remote-drifted"])
	})

	test("reports active references and refuses unsafe removal", async () => {
		const source = join(root, "source.git")
		await runGit(["init", "--bare", "--initial-branch=main", source])
		await setPortableOrigin(source, "referenced")
		await runTestEffect(
			RepositoryService.pipe(
				Effect.flatMap((service) => service.add("agency", source, root)),
			),
		)
		await write(
			root,
			"tasks/active/TASK.md",
			`---
ticketUrl: null
repo: agency
branch: task/active
base: main
pr: null
---
`,
		)

		await expect(
			runTestEffect(
				RepositoryService.pipe(
					Effect.flatMap((service) => service.remove("agency", root)),
				),
			),
		).rejects.toThrow("active reference execution-unit:task/active")
		expect(await Bun.file(join(root, "repos/agency/HEAD")).exists()).toBe(true)
	})

	test("plans and applies missing portable repository setup", async () => {
		const source = join(root, "source.git")
		await runGit(["init", "--bare", "--initial-branch=main", source])
		const daemon = await startGitDaemon(root)
		try {
			await Bun.write(
				join(root, "agency.json"),
				JSON.stringify({
					version: 2,
					repositories: { agency: { remote: daemon.remote } },
				}),
			)

			const result = await runTestEffect(
				RepositoryService.pipe(
					Effect.flatMap((service) =>
						Effect.gen(function* () {
							const planned = yield* service.setup({ cwd: root })
							const absent = !(yield* Effect.promise(() =>
								Bun.file(join(root, "repos/agency/HEAD")).exists(),
							))
							const applied = yield* service.setup({ cwd: root, apply: true })
							return { planned, absent, applied }
						}),
					),
				),
			)

			expect(result.planned.mode).toBe("dry-run")
			expect(result.planned.actions[0]).toMatchObject({
				kind: "materialize",
				status: "planned",
			})
			expect(result.absent).toBe(true)
			expect(result.applied.actions[0]?.status).toBe("applied")
			expect(result.applied.repositories[0]?.states).toEqual([
				"declared",
				"materialized",
			])
			expect(await Bun.file(join(root, "repos/agency/HEAD")).exists()).toBe(
				true,
			)
		} finally {
			daemon.process.kill()
			await daemon.process.exited
		}
	})

	test("adopts legacy materializations and reports remote drift", async () => {
		const legacy = join(root, "repos/legacy")
		await mkdir(legacy, { recursive: true })
		await runGit(["init", "--initial-branch=main", legacy])
		await setPortableOrigin(legacy, "legacy")

		const result = await runTestEffect(
			RepositoryService.pipe(
				Effect.flatMap((service) =>
					Effect.gen(function* () {
						const planned = yield* service.setup({ cwd: root })
						const applied = yield* service.setup({ cwd: root, apply: true })
						yield* Effect.promise(() =>
							runGit([
								"-C",
								legacy,
								"remote",
								"set-url",
								"origin",
								"https://example.com/agency-tests/changed.git",
							]),
						)
						const drifted = yield* service.show("legacy", root)
						const setup = yield* service.setup({ cwd: root })
						return { planned, applied, drifted, setup }
					}),
				),
			),
		)

		expect(result.planned.actions[0]?.kind).toBe("adopt")
		expect(result.applied.repositories[0]?.states).toEqual([
			"declared",
			"materialized",
		])
		expect(result.drifted.states).toContain("remote-drifted")
		expect(result.setup.unresolved[0]).toMatchObject({
			alias: "legacy",
			state: "remote-drifted",
		})
	})
})
