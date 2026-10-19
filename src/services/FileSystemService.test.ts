import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { cleanupTempDir, createTempDir } from "../test-utils"
import { FileSystemService } from "./FileSystemService"

const runFileSystem = <A, E>(effect: Effect.Effect<A, E, FileSystemService>) =>
	Effect.runPromise(effect.pipe(Effect.provide(FileSystemService.layer)))

describe("FileSystemService", () => {
	const roots: string[] = []

	afterEach(async () => {
		await Promise.all(roots.splice(0).map(cleanupTempDir))
	})

	test("distinguishes missing files from other read failures", async () => {
		const root = await createTempDir()
		roots.push(root)
		const directory = join(root, "document")
		await mkdir(directory)

		const missing = await runFileSystem(
			FileSystemService.pipe(
				Effect.flatMap((service) => service.readFile(join(root, "missing"))),
				Effect.result,
			),
		)
		expect(missing).toMatchObject({
			_tag: "Failure",
			failure: { _tag: "FileNotFoundError" },
		})

		const unreadable = await runFileSystem(
			FileSystemService.pipe(
				Effect.flatMap((service) => service.readFile(directory)),
				Effect.result,
			),
		)
		expect(unreadable).toMatchObject({
			_tag: "Failure",
			failure: {
				_tag: "FileSystemError",
				message: `Failed to read file: ${directory}`,
			},
		})
	})

	test("only treats a missing symlink path as absent", async () => {
		const root = await createTempDir()
		roots.push(root)
		const regularFile = join(root, "regular")
		await Bun.write(regularFile, "content")

		await expect(
			runFileSystem(
				FileSystemService.pipe(
					Effect.flatMap((service) =>
						service.readSymlinkTarget(join(root, "missing")),
					),
				),
			),
		).resolves.toBeNull()
		const unreadable = await runFileSystem(
			FileSystemService.pipe(
				Effect.flatMap((service) =>
					service.readSymlinkTarget(join(regularFile, "child")),
				),
				Effect.result,
			),
		)
		expect(unreadable).toMatchObject({
			_tag: "Failure",
			failure: {
				_tag: "FileSystemError",
				message: `Failed to read symlink target: ${join(regularFile, "child")}`,
			},
		})
	})

	test("says why a command could not run", async () => {
		const root = await createTempDir()
		roots.push(root)
		const runCommand = (
			args: readonly string[],
			options: { cwd?: string; timeoutMs?: number },
		) =>
			runFileSystem(
				FileSystemService.pipe(
					Effect.flatMap((service) =>
						service.runCommand(args, { captureOutput: true, ...options }),
					),
					Effect.flip,
				),
			)

		const timedOut = await runCommand(["sh", "-c", "sleep 30 & wait"], {
			timeoutMs: 25,
		})
		expect(timedOut.message).toMatch(
			/^Command timed out after \d+ ms: sh -c sleep 30 & wait$/,
		)

		const unstarted = await runCommand(["true"], {
			cwd: join(root, "missing"),
		})
		expect(unstarted.message).toStartWith("Failed to run command: true (")
	})
})
