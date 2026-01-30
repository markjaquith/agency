import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { join } from "path"
import { emitted } from "./emitted"
import {
	createTempDir,
	cleanupTempDir,
	initGitRepo,
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

describe("emitted command", () => {
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
		test("returns emit branch name when on source branch", async () => {
			// Create source branch (agency--main)
			await createBranch(tempDir, "agency--main")
			await createCommit(tempDir, "Work on source")

			// Capture output
			const originalLog = console.log
			let capturedOutput = ""
			console.log = (msg: string) => {
				capturedOutput = msg
			}

			await runTestEffect(emitted({ silent: false }))

			console.log = originalLog
			expect(capturedOutput).toBe("main")
		})

		test("returns emit branch name when on emit branch", async () => {
			// Create source branch
			await createBranch(tempDir, "agency--main")
			await createCommit(tempDir, "Work on source")

			// Switch to emit branch (main)
			await checkoutBranch(tempDir, "main")

			// Capture output
			const originalLog = console.log
			let capturedOutput = ""
			console.log = (msg: string) => {
				capturedOutput = msg
			}

			await runTestEffect(emitted({ silent: false }))

			console.log = originalLog
			expect(capturedOutput).toBe("main")
		})

		test("returns emit branch with custom pattern", async () => {
			// Create custom config
			const configPath = join(tempDir, "custom-config.json")
			await Bun.write(
				configPath,
				JSON.stringify({
					sourceBranchPattern: "agency--%branch%",
					emitBranch: "%branch%--PR",
				}),
			)
			process.env.AGENCY_CONFIG_PATH = configPath

			// Create source branch
			await createBranch(tempDir, "agency--feature")
			await createCommit(tempDir, "Feature work")

			// Capture output
			const originalLog = console.log
			let capturedOutput = ""
			console.log = (msg: string) => {
				capturedOutput = msg
			}

			await runTestEffect(emitted({ silent: false }))

			console.log = originalLog
			expect(capturedOutput).toBe("feature--PR")
		})

		test("returns emit branch from agency.json when present", async () => {
			// Create source branch
			await createBranch(tempDir, "agency--feature")

			// Create agency.json with custom emitBranch
			const agencyJsonPath = join(tempDir, "agency.json")
			await Bun.write(
				agencyJsonPath,
				JSON.stringify({
					version: 1,
					injectedFiles: [],
					template: "test-template",
					createdAt: new Date().toISOString(),
					emitBranch: "custom-emit-name",
				}),
			)

			// Commit the agency.json file so it's available on the branch
			await Bun.spawn(["git", "add", "agency.json"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited
			await createCommit(tempDir, "Add agency.json")

			// Capture output
			const originalLog = console.log
			let capturedOutput = ""
			console.log = (msg: string) => {
				capturedOutput = msg
			}

			await runTestEffect(emitted({ silent: false }))

			console.log = originalLog
			expect(capturedOutput).toBe("custom-emit-name")
		})

		test("works with legacy branch names", async () => {
			// On a branch that doesn't match the source pattern
			// Should treat it as a legacy branch and apply emit pattern
			await createBranch(tempDir, "feature-foo")

			// Capture output
			const originalLog = console.log
			let capturedOutput = ""
			console.log = (msg: string) => {
				capturedOutput = msg
			}

			await runTestEffect(emitted({ silent: false }))

			console.log = originalLog
			// With default pattern "%branch%", emit should be the same as clean branch
			expect(capturedOutput).toBe("feature-foo")
		})
	})

	describe("silent mode", () => {
		test("still outputs when not in silent mode", async () => {
			await createBranch(tempDir, "agency--main")

			const originalLog = console.log
			let logCalled = false
			console.log = () => {
				logCalled = true
			}

			await runTestEffect(emitted({ silent: false }))

			console.log = originalLog
			expect(logCalled).toBe(true)
		})

		test("silent flag suppresses output", async () => {
			await createBranch(tempDir, "agency--main")

			const originalLog = console.log
			let logCalled = false
			console.log = () => {
				logCalled = true
			}

			await runTestEffect(emitted({ silent: true }))

			console.log = originalLog
			expect(logCalled).toBe(false)
		})
	})

	describe("error handling", () => {
		test("throws error when not in a git repository", async () => {
			const nonGitDir = await createTempDir()
			process.chdir(nonGitDir)

			await expect(runTestEffect(emitted({ silent: true }))).rejects.toThrow(
				"Not in a git repository",
			)

			await cleanupTempDir(nonGitDir)
		})
	})
})
