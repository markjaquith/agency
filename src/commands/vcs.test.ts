import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
	captureLogs,
	cleanupTempDir,
	createTempDir,
	runTestEffect,
} from "../test-utils"
import { vcs } from "./vcs"

describe("vcs command", () => {
	let root: string

	beforeEach(async () => {
		root = await createTempDir()
		await Bun.write(
			`${root}/agency.json`,
			JSON.stringify({ version: 2, vcs: "git" }),
		)
	})

	afterEach(async () => cleanupTempDir(root))

	test("reports structured backend status", async () => {
		const logs = await captureLogs(() =>
			runTestEffect(vcs({ subcommand: "status", cwd: root, json: true })),
		)
		expect(JSON.parse(logs[0]!)).toMatchObject({
			root,
			configured: "git",
			source: "git",
			target: "git",
			workspaceCount: 0,
			blockers: [],
		})
	})

	test("persists the inferred Git backend for a legacy workbase", async () => {
		await Bun.write(`${root}/agency.json`, JSON.stringify({ version: 2 }))
		await captureLogs(() =>
			runTestEffect(
				vcs({
					subcommand: "migrate",
					target: "git",
					cwd: root,
					apply: true,
					json: true,
				}),
			),
		)
		expect(await Bun.file(`${root}/agency.json`).json()).toEqual({
			version: 2,
			vcs: "git",
		})
	})

	test("treats migration to the configured backend as a no-op", async () => {
		const logs = await captureLogs(() =>
			runTestEffect(
				vcs({
					subcommand: "migrate",
					target: "git",
					cwd: root,
					apply: true,
					json: true,
				}),
			),
		)
		expect(JSON.parse(logs[0]!)).toMatchObject({
			source: "git",
			target: "git",
			mode: "apply",
			actions: [],
		})
	})
})
