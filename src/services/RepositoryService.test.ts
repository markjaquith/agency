import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
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
})
