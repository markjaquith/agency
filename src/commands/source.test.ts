import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { join } from "path"
import { source } from "./source"
import {
	createTempDir,
	cleanupTempDir,
	initGitRepo,
	getGitOutput,
	getCurrentBranch,
	createCommit,
	runTestEffect,
} from "../test-utils"

async function createBranch(cwd: string, branchName: string): Promise<void> {
	await Bun.spawn(["git", "checkout", "-b", branchName], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	}).exited
}

describe("source command", () => {
	let tempDir: string
	let originalCwd: string

	beforeEach(async () => {
		tempDir = await createTempDir()
		originalCwd = process.cwd()
		process.chdir(tempDir)

		// Set config path to non-existent file to use defaults
		process.env.AGENCY_CONFIG_PATH = join(tempDir, "non-existent-config.json")

		// Initialize git repo
		await initGitRepo(tempDir)
		await createCommit(tempDir, "Initial commit")

		// Rename to main if needed
		const currentBranch = await getCurrentBranch(tempDir)
		if (currentBranch === "master") {
			await Bun.spawn(["git", "branch", "-m", "main"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited
		}
	})

	afterEach(async () => {
		process.chdir(originalCwd)
		delete process.env.AGENCY_CONFIG_PATH
		await cleanupTempDir(tempDir)
	})

	describe("basic functionality", () => {
		test("switches from PR branch to source branch", async () => {
			// Create a PR branch
			await createBranch(tempDir, "main--PR")

			// Run source command
			await runTestEffect(source({ silent: true }))

			// Should be on main now
			const currentBranch = await getCurrentBranch(tempDir)
			expect(currentBranch).toBe("main")
		})

		test("works with custom PR branch pattern", async () => {
			// Create custom config
			const configPath = join(tempDir, "custom-config.json")
			await Bun.write(configPath, JSON.stringify({ emitBranch: "PR/%branch%" }))
			process.env.AGENCY_CONFIG_PATH = configPath

			// Create feature branch and its PR branch
			await createBranch(tempDir, "feature")
			await createCommit(tempDir, "Feature work")
			await createBranch(tempDir, "PR/feature")

			// Run source command
			await runTestEffect(source({ silent: true }))

			// Should be on feature now
			const currentBranch = await getCurrentBranch(tempDir)
			expect(currentBranch).toBe("feature")
		})
	})

	describe("error handling", () => {
		test("throws error when not on an emit branch", async () => {
			// We're on main, which is not an emit branch
			await expect(runTestEffect(source({ silent: true }))).rejects.toThrow(
				"Not on an emit branch",
			)
		})

		test("throws error when source branch doesn't exist", async () => {
			// Create PR branch but delete source
			await createBranch(tempDir, "feature--PR")
			// We never created 'feature', so it doesn't exist

			await expect(runTestEffect(source({ silent: true }))).rejects.toThrow(
				"Source branch",
			)
		})

		test("throws error when not in a git repository", async () => {
			const nonGitDir = await createTempDir()
			process.chdir(nonGitDir)

			await expect(runTestEffect(source({ silent: true }))).rejects.toThrow(
				"Not in a git repository",
			)

			await cleanupTempDir(nonGitDir)
		})
	})

	describe("silent mode", () => {
		test("silent flag suppresses output", async () => {
			await createBranch(tempDir, "main--PR")

			// Capture output
			const originalLog = console.log
			let logCalled = false
			console.log = () => {
				logCalled = true
			}

			await runTestEffect(source({ silent: true }))

			console.log = originalLog
			expect(logCalled).toBe(false)
		})
	})
})
