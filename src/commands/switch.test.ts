import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { join } from "path"
import { switchBranch } from "./switch"
import {
	createTempDir,
	cleanupTempDir,
	initGitRepo,
	getGitOutput,
	getCurrentBranch,
	createCommit,
	checkoutBranch,
	runTestEffect,
} from "../test-utils"

async function createBranch(cwd: string, branchName: string): Promise<void> {
	await Bun.spawn(["git", "checkout", "-b", branchName], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	}).exited
}

describe("switch command", () => {
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
			// Create source and emit branches (source=agency--main, emit=main)
			await createBranch(tempDir, "agency--main")
			await createCommit(tempDir, "Work on source")
			// Emit branch is just "main" (already exists from setup)
			await checkoutBranch(tempDir, "main")

			// Run switch command
			await runTestEffect(switchBranch({ silent: true }))

			// Should be on source branch now
			const currentBranch = await getCurrentBranch(tempDir)
			expect(currentBranch).toBe("agency--main")
		})

		test("switches from source branch to emit branch", async () => {
			// Create source branch (main becomes the emit branch)
			await createBranch(tempDir, "agency--main")
			await createCommit(tempDir, "Work on source")

			// We're on agency--main (source), switch to main (emit)
			// Run switch command
			await runTestEffect(switchBranch({ silent: true }))

			// Should be on emit branch now
			const currentBranch = await getCurrentBranch(tempDir)
			expect(currentBranch).toBe("main")
		})

		test("toggles back and forth", async () => {
			// Create source and emit branches
			await createBranch(tempDir, "agency--main")
			await createCommit(tempDir, "Work on source")
			await checkoutBranch(tempDir, "main") // Go to emit

			// Switch to source
			await runTestEffect(switchBranch({ silent: true }))
			expect(await getCurrentBranch(tempDir)).toBe("agency--main")

			// Switch back to emit
			await runTestEffect(switchBranch({ silent: true }))
			expect(await getCurrentBranch(tempDir)).toBe("main")

			// And back to source
			await runTestEffect(switchBranch({ silent: true }))
			expect(await getCurrentBranch(tempDir)).toBe("agency--main")
		})

		test("works with custom emit branch pattern", async () => {
			// Create custom config
			const configPath = join(tempDir, "custom-config.json")
			await Bun.write(
				configPath,
				JSON.stringify({
					sourceBranchPattern: "agency--%branch%",
					emitBranch: "PR--%branch%",
				}),
			)
			process.env.AGENCY_CONFIG_PATH = configPath

			// Create source branch and its emit branch
			await createBranch(tempDir, "agency--feature")
			await createCommit(tempDir, "Feature work")
			await createBranch(tempDir, "PR--feature")

			// Switch to source
			await runTestEffect(switchBranch({ silent: true }))
			expect(await getCurrentBranch(tempDir)).toBe("agency--feature")

			// Switch back to emit
			await runTestEffect(switchBranch({ silent: true }))
			expect(await getCurrentBranch(tempDir)).toBe("PR--feature")
		})
	})

	describe("error handling", () => {
		test("throws error when emit branch doesn't exist", async () => {
			// Use custom emit pattern so emit branch differs from source
			const configPath = join(tempDir, "custom-config.json")
			await Bun.write(
				configPath,
				JSON.stringify({
					sourceBranchPattern: "agency--%branch%",
					emitBranch: "%branch%--PR",
				}),
			)
			process.env.AGENCY_CONFIG_PATH = configPath

			// Create source branch, but not the emit branch
			await createBranch(tempDir, "agency--feature")
			// feature--PR doesn't exist

			await expect(
				runTestEffect(switchBranch({ silent: true })),
			).rejects.toThrow(/Emit branch .* does not exist/)
		})

		test("throws error when emit branch doesn't exist", async () => {
			// Create source branch but no emit branch
			await createBranch(tempDir, "agency--feature")
			// We never created 'feature' (emit), so it doesn't exist

			await expect(
				runTestEffect(switchBranch({ silent: true })),
			).rejects.toThrow(/Emit branch .* does not exist/)
		})

		test("throws error when not in a git repository", async () => {
			const nonGitDir = await createTempDir()
			process.chdir(nonGitDir)

			await expect(
				runTestEffect(switchBranch({ silent: true })),
			).rejects.toThrow("Not in a git repository")

			await cleanupTempDir(nonGitDir)
		})
	})

	describe("silent mode", () => {
		test("silent flag suppresses output", async () => {
			await createBranch(tempDir, "agency--main")
			await checkoutBranch(tempDir, "main")

			// Capture output
			const originalLog = console.log
			let logCalled = false
			console.log = () => {
				logCalled = true
			}

			await runTestEffect(switchBranch({ silent: true }))

			console.log = originalLog
			expect(logCalled).toBe(false)
		})
	})
})
