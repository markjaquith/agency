import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import {
	captureLogs,
	cleanupTempDir,
	createTempDir,
	runTestEffect,
} from "../test-utils"
import { repo } from "./repo"

describe("repo command", () => {
	let root: string

	beforeEach(async () => {
		root = await createTempDir()
		await Bun.write(join(root, "agency.json"), '{"version":2}\n')
		await mkdir(join(root, "repos/agency"), { recursive: true })
	})

	afterEach(async () => cleanupTempDir(root))

	test("requires a subcommand", async () => {
		await expect(
			runTestEffect(repo({ args: [], silent: true })),
		).rejects.toThrow("Available subcommands: add, link, list")
	})

	test("requires add arguments", async () => {
		await expect(
			runTestEffect(
				repo({ subcommand: "add", args: ["agency"], silent: true }),
			),
		).rejects.toThrow("Usage: agency repo add")
	})

	test("lists repository metadata as JSON", async () => {
		const logs = await captureLogs(() =>
			runTestEffect(
				repo({ subcommand: "list", args: [], cwd: root, json: true }),
			),
		)

		expect(JSON.parse(logs[0]!)).toEqual([
			{
				alias: "agency",
				path: join(root, "repos/agency"),
				kind: "repository",
				remote: null,
				target: null,
			},
		])
	})

	test("shows a repository by alias as JSON", async () => {
		const logs = await captureLogs(() =>
			runTestEffect(
				repo({
					subcommand: "show",
					args: ["agency"],
					cwd: root,
					json: true,
				}),
			),
		)

		expect(JSON.parse(logs[0]!).alias).toBe("agency")
	})

	test("outputs a linked repository as JSON", async () => {
		const target = join(root, "source")
		await mkdir(target)
		const git = Bun.spawn(["git", "init", target], {
			stdout: "ignore",
			stderr: "ignore",
		})
		expect(await git.exited).toBe(0)

		const logs = await captureLogs(() =>
			runTestEffect(
				repo({
					subcommand: "link",
					args: ["linked", target],
					cwd: root,
					json: true,
				}),
			),
		)

		expect(JSON.parse(logs[0]!)).toEqual({
			alias: "linked",
			path: join(root, "repos/linked"),
		})
	})

	test("unlinks a linked repository by alias", async () => {
		const target = join(root, "unlink-source")
		await mkdir(target)
		const git = Bun.spawn(["git", "init", target], {
			stdout: "ignore",
			stderr: "ignore",
		})
		expect(await git.exited).toBe(0)
		await runTestEffect(
			repo({
				subcommand: "link",
				args: ["linked", target],
				cwd: root,
				silent: true,
			}),
		)

		await runTestEffect(
			repo({
				subcommand: "unlink",
				args: ["linked"],
				cwd: root,
				silent: true,
			}),
		)

		expect(await Bun.file(join(target, ".git/HEAD")).exists()).toBe(true)
	})
})
