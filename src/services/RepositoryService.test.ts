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

		const destination = await runTestEffect(
			RepositoryService.pipe(
				Effect.flatMap((service) => service.add("agency", source, root)),
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
				remote: source,
				target: null,
			},
		])
	})

	test("links an existing repository", async () => {
		const target = join(root, "linked-repository")
		await mkdir(target, { recursive: true })
		await runGit(["init", "--initial-branch=main", target])

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
			remote: null,
			target,
		})
	})

	test("rejects invalid and duplicate aliases", async () => {
		const source = join(root, "source.git")
		await runGit(["init", "--bare", "--initial-branch=main", source])

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

	test("shows, fetches, updates, and verifies a repository", async () => {
		const source = join(root, "source")
		const replacement = join(root, "replacement.git")
		await runGit(["init", "--initial-branch=main", source])
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
		await runGit(["init", "--bare", "--initial-branch=main", replacement])
		await runTestEffect(
			RepositoryService.pipe(
				Effect.flatMap((service) => service.add("agency", source, root)),
			),
		)

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
		expect(result.updated.remote).toBe(replacement)
		expect(result.verified.valid).toBe(true)
		expect(result.verified.issues).toEqual([])
	})

	test("renames and removes an unused repository", async () => {
		const source = join(root, "source.git")
		await runGit(["init", "--bare", "--initial-branch=main", source])
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
	})

	test("reports active references and refuses unsafe removal", async () => {
		const source = join(root, "source.git")
		await runGit(["init", "--bare", "--initial-branch=main", source])
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
})
