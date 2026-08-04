import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdir, realpath, stat } from "node:fs/promises"
import { join } from "node:path"
import { cleanupTempDir, createTempDir, runTestEffect } from "../test-utils"
import { VersionControlService } from "./VersionControlService"
import { preferredVersionControl } from "../workbase/version-control"

const run = async (args: string[], cwd?: string) => {
	const child = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" })
	const exitCode = await child.exited
	if (exitCode !== 0) throw new Error(await new Response(child.stderr).text())
}

describe("VersionControlService", () => {
	const roots: string[] = []

	afterEach(async () => {
		await Promise.all(roots.splice(0).map(cleanupTempDir))
	})

	test("prefers jj when available and falls back to Git", () => {
		expect(preferredVersionControl(() => "/usr/bin/jj")).toBe("jj")
		expect(preferredVersionControl(() => null)).toBe("git")
	})

	test("selects the backend persisted by the workbase", async () => {
		for (const kind of ["git", "jj"] as const) {
			const root = await createTempDir()
			roots.push(root)
			await Bun.write(
				join(root, "agency.json"),
				JSON.stringify({ version: 2, vcs: kind }),
			)
			const selected = await runTestEffect(
				VersionControlService.pipe(
					Effect.flatMap((service) => service.forWorkbase(root)),
				),
			)
			expect(selected.kind).toBe(kind)
		}
	})

	test("initializes and manages jj workspaces", async () => {
		if (!Bun.which("jj")) return
		const root = await createTempDir()
		roots.push(root)
		await Bun.write(
			join(root, "agency.json"),
			JSON.stringify({ version: 2, vcs: "jj" }),
		)
		const repository = join(root, "repository")
		const workspace = join(root, "workspace")
		await mkdir(repository)
		await run(["git", "init", "--initial-branch=main"], repository)
		await run(["git", "config", "user.email", "test@example.com"], repository)
		await run(["git", "config", "user.name", "Test"], repository)
		await Bun.write(join(repository, "README.md"), "example\n")
		await run(["git", "add", "README.md"], repository)
		await run(["git", "commit", "-m", "initial"], repository)

		const backend = await runTestEffect(
			VersionControlService.pipe(
				Effect.flatMap((service) => service.forWorkbase(root)),
			),
		)
		await runTestEffect(backend.initializeRepository(repository))
		expect((await stat(join(repository, ".jj"))).isDirectory()).toBe(true)

		const revision = await runTestEffect(
			backend.resolveRevision(repository, "main"),
		)
		expect(revision).toMatch(/^[0-9a-f]{40}$/)
		await runTestEffect(
			backend.createWorkspace({
				repositoryPath: repository,
				workspacePath: workspace,
				workspaceName: "agency-test",
				revision: revision!,
				branch: "task/test",
			}),
		)
		const canonicalWorkspace = await realpath(workspace)
		expect(
			(await runTestEffect(backend.listWorkspaces(repository))).some(
				(item) =>
					item.name === "agency-test" && item.path === canonicalWorkspace,
			),
		).toBe(true)

		await runTestEffect(
			backend.removeWorkspace({
				repositoryPath: repository,
				workspacePath: workspace,
				workspaceName: "agency-test",
			}),
		)
		expect(await Bun.file(workspace).exists()).toBe(false)
	})
})
