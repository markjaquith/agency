import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { join } from "node:path"
import { cleanupTempDir, createTempDir, runTestEffect } from "../test-utils"
import {
	GitVersionControlService,
	VersionControlService,
} from "./VersionControlService"
import { FileSystemService } from "./FileSystemService"

describe("VersionControlService", () => {
	const roots: string[] = []

	afterEach(async () => {
		await Promise.all(roots.splice(0).map(cleanupTempDir))
	})

	test("inspects a Git repository with one subprocess", async () => {
		const commands: readonly string[][] = []
		const fileSystem = {
			...FileSystemService.Default,
			runCommand: (command: readonly string[]) => {
				;(commands as string[][]).push([...command])
				return Effect.succeed({
					exitCode: 0,
					stdout:
						"local\tcore.bare true\nlocal\tremote.origin.url agency:agency.git\nglobal\turl.https://example.com/.insteadof agency:\n",
					stderr: "",
				})
			},
		} as unknown as Effect.Effect.Success<typeof FileSystemService>
		const backend = await Effect.runPromise(
			GitVersionControlService.pipe(
				Effect.provide(GitVersionControlService.Default),
			),
		)
		const inspection = await Effect.runPromise(
			backend
				.inspectRepository("/repository")
				.pipe(Effect.provide(Layer.succeed(FileSystemService, fileSystem))),
		)

		expect(commands).toHaveLength(1)
		expect(commands[0]).toContain("--get-regexp")
		expect(inspection).toEqual({
			kind: "bare",
			remote: "https://example.com/agency.git",
		})
	})

	test("selects Git for legacy and explicit Git workbases", async () => {
		const root = await createTempDir()
		roots.push(root)
		await Bun.write(join(root, "agency.json"), JSON.stringify({ version: 2 }))
		const selected = await runTestEffect(
			VersionControlService.pipe(
				Effect.flatMap((service) => service.forWorkbase(root)),
			),
		)
		expect(selected.kind).toBe("git")
	})
})
