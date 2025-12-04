import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { join } from "path"
import { source } from "./source"
import {
	createTempDir,
	cleanupTempDir,
	initGitRepo,
	getCurrentBranch,
	createCommit,
	runTestEffect,
} from "../test-utils"
import { writeAgencyMetadata } from "../types"

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
		test("switches from emit branch to source branch", async () => {
			// Create source branch with agency.json
			await createBranch(tempDir, "agency/feature")
			await writeAgencyMetadata(tempDir, {
				version: 1,
				injectedFiles: [],
				template: "test-template",
				emitBranch: "feature",
				createdAt: new Date().toISOString(),
			} as any)
			// Stage and commit agency.json
			await Bun.spawn(["git", "add", "agency.json"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited
			await createCommit(tempDir, "Setup")

			// Create emit branch and remove agency.json
			await createBranch(tempDir, "feature")
			await Bun.spawn(["rm", "agency.json"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited

			// Run source command (should switch from feature emit branch to agency/feature source)
			await runTestEffect(source({ silent: true }))

			// Should be on agency/feature now
			const currentBranch = await getCurrentBranch(tempDir)
			expect(currentBranch).toBe("agency/feature")
		})

		test("works with custom emit branch pattern", async () => {
			// Create custom config with custom patterns
			const configPath = join(tempDir, "custom-config.json")
			await Bun.write(
				configPath,
				JSON.stringify({
					sourceBranchPattern: "WIP/%branch%",
					emitBranch: "PR/%branch%",
				}),
			)
			process.env.AGENCY_CONFIG_PATH = configPath

			// Create source branch with agency.json
			await createBranch(tempDir, "WIP/feature")
			await writeAgencyMetadata(tempDir, {
				version: 1,
				injectedFiles: [],
				template: "test-template",
				emitBranch: "PR/feature",
				createdAt: new Date().toISOString(),
			} as any)
			// Stage and commit
			await Bun.spawn(["git", "add", "agency.json"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited
			await createCommit(tempDir, "Feature work")

			// Create emit branch
			await createBranch(tempDir, "PR/feature")
			await Bun.spawn(["rm", "agency.json"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited

			// Run source command (from PR/feature to WIP/feature)
			await runTestEffect(source({ silent: true }))

			// Should be on WIP/feature now
			const currentBranch = await getCurrentBranch(tempDir)
			expect(currentBranch).toBe("WIP/feature")
		})
	})

	describe("error handling", () => {
		test("throws error when not on an emit branch", async () => {
			// We're on main, which is not an emit branch
			await expect(runTestEffect(source({ silent: true }))).rejects.toThrow(
				"Not on an emit branch",
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
			// Create source branch with agency.json
			await createBranch(tempDir, "agency/feature")
			await writeAgencyMetadata(tempDir, {
				version: 1,
				injectedFiles: [],
				template: "test-template",
				emitBranch: "feature",
				createdAt: new Date().toISOString(),
			} as any)
			await Bun.spawn(["git", "add", "agency.json"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited
			await createCommit(tempDir, "Setup")

			// Create emit branch
			await createBranch(tempDir, "feature")
			await Bun.spawn(["rm", "agency.json"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited

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
