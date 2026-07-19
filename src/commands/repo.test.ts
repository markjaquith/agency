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
		).rejects.toThrow("Available subcommands: setup, add, link, list")
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
				declaredRemote: null,
				target: null,
				states: ["materialized", "invalid"],
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
		const remote = Bun.spawn(
			[
				"git",
				"-C",
				target,
				"remote",
				"add",
				"origin",
				"https://example.com/linked.git",
			],
			{ stdout: "ignore", stderr: "ignore" },
		)
		expect(await remote.exited).toBe(0)

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
		const remote = Bun.spawn(
			[
				"git",
				"-C",
				target,
				"remote",
				"add",
				"origin",
				"https://example.com/unlink.git",
			],
			{ stdout: "ignore", stderr: "ignore" },
		)
		expect(await remote.exited).toBe(0)
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
		expect(await Bun.file(join(root, "repos/linked")).exists()).toBe(false)
		const logs = await captureLogs(() =>
			runTestEffect(
				repo({ subcommand: "list", args: [], cwd: root, json: true }),
			),
		)
		expect(
			JSON.parse(logs[0]!).map(({ alias }: { alias: string }) => alias),
		).toEqual(["agency", "linked"])
	})

	test("reports setup plans as JSON without mutating", async () => {
		await Bun.write(
			join(root, "agency.json"),
			JSON.stringify({
				version: 2,
				repositories: {
					missing: { remote: "https://example.com/missing.git" },
				},
			}),
		)
		const logs = await captureLogs(() =>
			runTestEffect(
				repo({ subcommand: "setup", args: [], cwd: root, json: true }),
			),
		)
		const result = JSON.parse(logs[0]!)
		expect(result.mode).toBe("dry-run")
		expect(result.actions).toEqual([
			{
				kind: "materialize",
				alias: "missing",
				remote: "https://example.com/missing.git",
				status: "planned",
			},
		])
		expect(await Bun.file(join(root, "repos/missing")).exists()).toBe(false)
	})
})
