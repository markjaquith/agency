import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { join } from "path"
import { tasks } from "./tasks"
import {
	createTempDir,
	cleanupTempDir,
	initGitRepo,
	getCurrentBranch,
	createCommit,
	initAgency,
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

async function checkoutBranch(cwd: string, branchName: string): Promise<void> {
	await Bun.spawn(["git", "checkout", branchName], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	}).exited
}

describe("tasks command", () => {
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
		test("shows no task branches when none exist", async () => {
			let output = ""
			const originalLog = console.log
			console.log = (msg: string) => {
				output += msg + "\n"
			}

			await runTestEffect(tasks({}))

			console.log = originalLog
			expect(output).toContain("No task branches found")
			expect(output).toContain("agency task")
		})

		test("lists single task branch", async () => {
			// Initialize agency
			await initAgency(tempDir, "test-template")

			// Create feature branch with agency.json
			await createBranch(tempDir, "feature")
			await writeAgencyMetadata(tempDir, {
				version: 1,
				injectedFiles: ["AGENTS.md"],
				template: "test-template",
				baseBranch: "main",
				createdAt: new Date().toISOString(),
			} as any)

			// Commit agency.json
			await Bun.spawn(["git", "add", "agency.json"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited
			await createCommit(tempDir, "Add agency.json")

			let output = ""
			const originalLog = console.log
			console.log = (msg: string) => {
				output += msg + "\n"
			}

			await runTestEffect(tasks({}))

			console.log = originalLog
			expect(output).toContain("feature")
			expect(output.trim()).toBe("feature")
		})

		test("lists multiple task branches", async () => {
			await initAgency(tempDir, "test-template")

			// Create first feature branch
			await createBranch(tempDir, "feature-1")
			await writeAgencyMetadata(tempDir, {
				version: 1,
				injectedFiles: ["AGENTS.md"],
				template: "test-template",
				baseBranch: "main",
				createdAt: new Date().toISOString(),
			} as any)
			await Bun.spawn(["git", "add", "agency.json"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited
			await createCommit(tempDir, "Add agency.json")

			// Go back to main and create second feature branch
			await checkoutBranch(tempDir, "main")
			await createBranch(tempDir, "feature-2")
			await writeAgencyMetadata(tempDir, {
				version: 1,
				injectedFiles: ["opencode.json"],
				template: "another-template",
				baseBranch: "main",
				createdAt: new Date().toISOString(),
			} as any)
			await Bun.spawn(["git", "add", "agency.json"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited
			await createCommit(tempDir, "Add agency.json")

			let output = ""
			const originalLog = console.log
			console.log = (msg: string) => {
				output += msg + "\n"
			}

			await runTestEffect(tasks({}))

			console.log = originalLog
			expect(output).toContain("feature-1")
			expect(output).toContain("feature-2")
			const lines = output.trim().split("\n")
			expect(lines.length).toBe(2)
		})

		test("ignores branches without agency.json", async () => {
			await initAgency(tempDir, "test-template")

			// Create a branch without agency.json
			await createBranch(tempDir, "no-agency")
			await createCommit(tempDir, "Some work")

			// Go back to main and create a branch with agency.json
			await checkoutBranch(tempDir, "main")
			await createBranch(tempDir, "with-agency")
			await writeAgencyMetadata(tempDir, {
				version: 1,
				injectedFiles: [],
				template: "test-template",
				createdAt: new Date().toISOString(),
			} as any)
			await Bun.spawn(["git", "add", "agency.json"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited
			await createCommit(tempDir, "Add agency.json")

			let output = ""
			const originalLog = console.log
			console.log = (msg: string) => {
				output += msg + "\n"
			}

			await runTestEffect(tasks({}))

			console.log = originalLog
			expect(output).toContain("with-agency")
			expect(output).not.toContain("no-agency")
			expect(output.trim()).toBe("with-agency")
		})
	})

	describe("JSON output", () => {
		test("outputs JSON format when --json is provided", async () => {
			await initAgency(tempDir, "test-template")

			await createBranch(tempDir, "feature")
			const createdAt = new Date().toISOString()
			await writeAgencyMetadata(tempDir, {
				version: 1,
				injectedFiles: ["AGENTS.md"],
				template: "test-template",
				baseBranch: "main",
				createdAt,
			} as any)
			await Bun.spawn(["git", "add", "agency.json"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited
			await createCommit(tempDir, "Add agency.json")

			let output = ""
			const originalLog = console.log
			console.log = (msg: string) => {
				output += msg + "\n"
			}

			await runTestEffect(tasks({ json: true }))

			console.log = originalLog

			// Parse JSON output
			const data = JSON.parse(output.trim())
			expect(Array.isArray(data)).toBe(true)
			expect(data.length).toBe(1)
			expect(data[0].branch).toBe("feature")
			expect(data[0].template).toBe("test-template")
			expect(data[0].baseBranch).toBe("main")
			expect(data[0].createdAt).toBeDefined()
		})

		test("outputs empty array in JSON format when no task branches exist", async () => {
			let output = ""
			const originalLog = console.log
			console.log = (msg: string) => {
				output += msg + "\n"
			}

			await runTestEffect(tasks({ json: true }))

			console.log = originalLog

			const data = JSON.parse(output.trim())
			expect(Array.isArray(data)).toBe(true)
			expect(data.length).toBe(0)
		})
	})

	describe("edge cases", () => {
		test("handles branches with invalid agency.json gracefully", async () => {
			await initAgency(tempDir, "test-template")

			// Create branch with invalid agency.json
			await createBranch(tempDir, "invalid")
			await Bun.write(join(tempDir, "agency.json"), "{ invalid json }")
			await Bun.spawn(["git", "add", "agency.json"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited
			await createCommit(tempDir, "Add invalid agency.json")

			// Create branch with valid agency.json
			await checkoutBranch(tempDir, "main")
			await createBranch(tempDir, "valid")
			await writeAgencyMetadata(tempDir, {
				version: 1,
				injectedFiles: [],
				template: "test-template",
				createdAt: new Date().toISOString(),
			} as any)
			await Bun.spawn(["git", "add", "agency.json"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited
			await createCommit(tempDir, "Add valid agency.json")

			let output = ""
			const originalLog = console.log
			console.log = (msg: string) => {
				output += msg + "\n"
			}

			await runTestEffect(tasks({}))

			console.log = originalLog
			expect(output).toContain("valid")
			expect(output).not.toContain("invalid")
			expect(output.trim()).toBe("valid")
		})

		test("handles branches with old version agency.json", async () => {
			await initAgency(tempDir, "test-template")

			// Create branch with version 0 agency.json (future or old version)
			await createBranch(tempDir, "old-version")
			await Bun.write(
				join(tempDir, "agency.json"),
				JSON.stringify({
					version: 0,
					template: "old-template",
				}),
			)
			await Bun.spawn(["git", "add", "agency.json"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited
			await createCommit(tempDir, "Add old version agency.json")

			let output = ""
			const originalLog = console.log
			console.log = (msg: string) => {
				output += msg + "\n"
			}

			await runTestEffect(tasks({}))

			console.log = originalLog
			expect(output).toContain("No task branches found")
		})
	})
})
