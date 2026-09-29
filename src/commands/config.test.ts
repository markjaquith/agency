import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { join } from "node:path"
import {
	captureLogs,
	cleanupTempDir,
	createTempDir,
	runTestEffect,
} from "../test-utils"
import { WorkbaseService } from "../services/WorkbaseService"
import { ContextService } from "../services/ContextService"
import { config } from "./config"
import { status } from "./status"
import { parseCli } from "../cli-parser"

describe("workbase auto archive setting", () => {
	let root: string
	beforeEach(async () => {
		root = await createTempDir()
		await Bun.write(
			join(root, "agency.json"),
			JSON.stringify({
				version: 2,
				repositories: {},
				chooserCommand: ["choose"],
			}),
		)
	})
	afterEach(async () => cleanupTempDir(root))
	const run = (args: string[], json = true) =>
		captureLogs(() => runTestEffect(config({ cwd: root, args, json })))

	test("shows the default and preserves unrelated configuration when toggled", async () => {
		expect(JSON.parse((await run(["auto-archive"]))[0]!)).toEqual({
			root,
			autoArchive: false,
		})
		await run(["auto-archive", "on"])
		expect(await Bun.file(join(root, "agency.json")).json()).toEqual({
			version: 2,
			repositories: {},
			chooserCommand: ["choose"],
			autoArchive: true,
		})
		expect(await run(["auto-archive"], false)).toEqual(["Auto archive: on"])
		await run(["auto-archive", "off"])
		expect(JSON.parse((await run(["auto-archive"]))[0]!).autoArchive).toBe(
			false,
		)
	})

	test("rejects invalid values without changing config", async () => {
		const before = await Bun.file(join(root, "agency.json")).text()
		await expect(run(["auto-archive", "maybe"])).rejects.toThrow("Usage:")
		expect(await Bun.file(join(root, "agency.json")).text()).toBe(before)
	})

	test("validates the stored setting as a boolean", async () => {
		await Bun.write(
			join(root, "agency.json"),
			'{"version":2,"autoArchive":"on"}',
		)
		await expect(
			runTestEffect(
				WorkbaseService.pipe(
					Effect.flatMap((service) => service.validate(root)),
				),
			),
		).rejects.toThrow("autoArchive")
	})

	test("includes effective setting in both context projections and status JSON", async () => {
		await run(["auto-archive", "on"])
		for (const full of [true, false]) {
			const result = await runTestEffect(
				ContextService.pipe(
					Effect.flatMap((service) =>
						service.get({ cwd: root, target: ".", full }),
					),
				),
			)
			expect(result.workbase.autoArchive).toBe(true)
		}
		const logs = await captureLogs(() =>
			runTestEffect(status({ cwd: root, json: true })),
		)
		expect(JSON.parse(logs[0]!).autoArchive).toBe(true)
	})

	test("parses show, enable, and disable commands", () => {
		for (const value of [undefined, "on", "off"]) {
			const parsed = parseCli([
				"config",
				"auto-archive",
				...(value ? [value] : []),
				"--json",
			])
			expect(parsed.commandName).toBe("config")
		}
	})

	test("honors silent output", async () => {
		const logs = await captureLogs(() =>
			runTestEffect(
				config({ cwd: root, args: ["auto-archive", "on"], silent: true }),
			),
		)
		expect(logs).toEqual([])
	})

	test("dispatches through the CLI and emits one machine envelope", async () => {
		const child = Bun.spawn(
			[
				process.execPath,
				join(import.meta.dir, "../../cli.ts"),
				"--cwd",
				root,
				"config",
				"auto-archive",
				"on",
				"--json",
			],
			{
				env: { ...process.env, XDG_CONFIG_HOME: join(root, "config") },
				stdout: "pipe",
				stderr: "pipe",
			},
		)
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		])
		expect(stderr).toBe("")
		expect(exitCode).toBe(0)
		expect(JSON.parse(stdout)).toMatchObject({
			version: 1,
			ok: true,
			result: { root, autoArchive: true },
		})
	})
})
