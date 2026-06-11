import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { pr } from "./pr"
import {
	cleanupTempDir,
	createBranch,
	createTempDir,
	initGitRepo,
	runTestEffect,
} from "../test-utils"

const restoreEnv = (key: string, value: string | undefined) => {
	if (value === undefined) {
		delete process.env[key]
		return
	}

	process.env[key] = value
}

const readGhArgs = async (recordPath: string): Promise<string[]> => {
	const file = Bun.file(recordPath)

	if (!(await file.exists())) {
		return []
	}

	const content = await file.text()
	return content.trim().split("\n").filter(Boolean)
}

describe("pr command", () => {
	let tempDir: string
	let recordPath: string
	let originalCwd: string
	let originalPath: string | undefined
	let originalAgencyConfigPath: string | undefined
	let originalGhArgsFile: string | undefined

	beforeEach(async () => {
		tempDir = await createTempDir()
		recordPath = join(tempDir, "gh-args.txt")
		originalCwd = process.cwd()
		originalPath = process.env.PATH
		originalAgencyConfigPath = process.env.AGENCY_CONFIG_PATH
		originalGhArgsFile = process.env.AGENCY_TEST_GH_ARGS_FILE

		process.chdir(tempDir)
		process.env.AGENCY_CONFIG_PATH = join(tempDir, "non-existent-config.json")
		process.env.AGENCY_TEST_GH_ARGS_FILE = recordPath

		const binDir = join(tempDir, "bin")
		const ghPath = join(binDir, "gh")
		await mkdir(binDir)
		await Bun.write(
			ghPath,
			`#!/bin/sh
: > "$AGENCY_TEST_GH_ARGS_FILE"
for arg in "$@"; do
	printf '%s\n' "$arg" >> "$AGENCY_TEST_GH_ARGS_FILE"
done
`,
		)
		await chmod(ghPath, 0o755)
		process.env.PATH = `${binDir}:${originalPath ?? ""}`

		await initGitRepo(tempDir)
	})

	afterEach(async () => {
		process.chdir(originalCwd)
		restoreEnv("PATH", originalPath)
		restoreEnv("AGENCY_CONFIG_PATH", originalAgencyConfigPath)
		restoreEnv("AGENCY_TEST_GH_ARGS_FILE", originalGhArgsFile)
		await cleanupTempDir(tempDir)
	})

	test("passes through to gh pr unchanged outside agency context", async () => {
		await createBranch(tempDir, "feature")

		await runTestEffect(pr({ args: ["status"], silent: false }))

		expect(await readGhArgs(recordPath)).toEqual(["pr", "status"])
	})

	test("passes through outside agency context with custom emit pattern", async () => {
		const configPath = process.env.AGENCY_CONFIG_PATH

		if (!configPath) {
			throw new Error("AGENCY_CONFIG_PATH is not set")
		}

		await Bun.write(
			configPath,
			JSON.stringify({
				sourceBranchPattern: "agency--%branch%",
				emitBranch: "%branch%--PR",
			}),
		)
		await createBranch(tempDir, "feature")

		await runTestEffect(pr({ args: ["status"], silent: false }))

		expect(await readGhArgs(recordPath)).toEqual(["pr", "status"])
	})

	test("appends emitted branch in agency context", async () => {
		await createBranch(tempDir, "agency--feature")

		await runTestEffect(pr({ args: ["view", "--web"], silent: false }))

		expect(await readGhArgs(recordPath)).toEqual([
			"pr",
			"view",
			"--web",
			"feature",
		])
	})

	test("appends emitted branch with gh pr value flags when no selector is provided", async () => {
		await createBranch(tempDir, "agency--feature")

		await runTestEffect(
			pr({
				args: ["view", "--json", "number", "--jq", ".number"],
				silent: false,
			}),
		)

		expect(await readGhArgs(recordPath)).toEqual([
			"pr",
			"view",
			"--json",
			"number",
			"--jq",
			".number",
			"feature",
		])
	})

	test("does not append emitted branch when an explicit selector is provided", async () => {
		await createBranch(tempDir, "agency--feature")

		await runTestEffect(
			pr({
				args: [
					"view",
					"123",
					"--json",
					"statusCheckRollup",
					"--jq",
					".statusCheckRollup[]",
				],
				silent: false,
			}),
		)

		expect(await readGhArgs(recordPath)).toEqual([
			"pr",
			"view",
			"123",
			"--json",
			"statusCheckRollup",
			"--jq",
			".statusCheckRollup[]",
		])
	})

	test("does not append emitted branch for subcommands without a selector", async () => {
		await createBranch(tempDir, "agency--feature")

		await runTestEffect(pr({ args: ["status"], silent: false }))

		expect(await readGhArgs(recordPath)).toEqual(["pr", "status"])
	})
})
