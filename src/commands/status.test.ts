import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { join } from "path"
import { status } from "./status"
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

describe("status command", () => {
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
		test("shows not initialized when agency.json is missing", async () => {
			let output = ""
			const originalLog = console.log
			console.log = (msg: string) => {
				output += msg + "\n"
			}

			await runTestEffect(status({}))

			console.log = originalLog
			expect(output).toContain("Not initialized")
			expect(output).toContain("agency task")
		})

		test("shows initialized when agency.json exists", async () => {
			// Initialize agency
			await initAgency(tempDir, "test-template")

			// Create feature branch with agency.json
			await createBranch(tempDir, "feature")
			await writeAgencyMetadata(tempDir, {
				version: 1,
				injectedFiles: ["AGENTS.md"],
				template: "test-template",
				createdAt: new Date().toISOString(),
			} as any)

			let output = ""
			const originalLog = console.log
			console.log = (msg: string) => {
				output += msg + "\n"
			}

			await runTestEffect(status({}))

			console.log = originalLog
			expect(output).toContain("Current branch:")
			expect(output).toContain("Branch type: Source branch")
			expect(output).toContain("Template:")
		})

		test("shows source branch type when on source branch", async () => {
			await initAgency(tempDir, "test-template")
			await createBranch(tempDir, "feature")
			await writeAgencyMetadata(tempDir, {
				version: 1,
				injectedFiles: [],
				template: "test-template",
				createdAt: new Date().toISOString(),
			} as any)

			let output = ""
			const originalLog = console.log
			console.log = (msg: string) => {
				output += msg + "\n"
			}

			await runTestEffect(status({}))

			console.log = originalLog
			expect(output).toContain("Branch type:")
			expect(output).toContain("Source branch")
		})

		test("shows emit branch type when on emit branch", async () => {
			await initAgency(tempDir, "test-template")

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
			await createCommit(tempDir, "Feature work")

			// Create and switch to emit branch
			await createBranch(tempDir, "feature")

			let output = ""
			const originalLog = console.log
			console.log = (msg: string) => {
				output += msg + "\n"
			}

			await runTestEffect(status({}))

			console.log = originalLog
			expect(output).toContain("Branch type:")
			expect(output).toContain("Emit branch")
		})

		test("shows corresponding branch when it exists", async () => {
			await initAgency(tempDir, "test-template")
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
			await createCommit(tempDir, "Set up branch")

			// Create emit branch
			await createBranch(tempDir, "feature")
			await checkoutBranch(tempDir, "agency/feature")

			let output = ""
			const originalLog = console.log
			console.log = (msg: string) => {
				output += msg + "\n"
			}

			await runTestEffect(status({}))

			console.log = originalLog
			expect(output).toContain("Emit branch: ")
			expect(output).toContain("feature")
		})

		test("shows backpack files", async () => {
			await initAgency(tempDir, "test-template")
			await createBranch(tempDir, "feature")
			await writeAgencyMetadata(tempDir, {
				version: 1,
				injectedFiles: ["AGENTS.md", "opencode.json"],
				template: "test-template",
				createdAt: new Date().toISOString(),
			} as any)

			let output = ""
			const originalLog = console.log
			console.log = (msg: string) => {
				output += msg + "\n"
			}

			await runTestEffect(status({}))

			console.log = originalLog
			expect(output).toContain("Backpack:")
			// Base backpack files (TASK.md, AGENCY.md, agency.json) + injected files (AGENTS.md, opencode.json)
			expect(output).toContain("TASK.md")
			expect(output).toContain("AGENCY.md")
			expect(output).toContain("agency.json")
			expect(output).toContain("AGENTS.md")
			expect(output).toContain("opencode.json")
		})

		test("shows base branch when set", async () => {
			await initAgency(tempDir, "test-template")
			await createBranch(tempDir, "feature")
			await writeAgencyMetadata(tempDir, {
				version: 1,
				injectedFiles: [],
				template: "test-template",
				baseBranch: "main",
				createdAt: new Date().toISOString(),
			} as any)

			let output = ""
			const originalLog = console.log
			console.log = (msg: string) => {
				output += msg + "\n"
			}

			await runTestEffect(status({}))

			console.log = originalLog
			expect(output).toContain("Base branch:")
			expect(output).toContain("main")
		})

		test("shows template name", async () => {
			await initAgency(tempDir, "my-custom-template")
			await createBranch(tempDir, "feature")
			await writeAgencyMetadata(tempDir, {
				version: 1,
				injectedFiles: [],
				template: "my-custom-template",
				createdAt: new Date().toISOString(),
			} as any)

			let output = ""
			const originalLog = console.log
			console.log = (msg: string) => {
				output += msg + "\n"
			}

			await runTestEffect(status({}))

			console.log = originalLog
			expect(output).toContain("Template:")
			expect(output).toContain("my-custom-template")
		})
	})

	describe("JSON output", () => {
		test("outputs valid JSON with --json flag", async () => {
			await initAgency(tempDir, "test-template")
			await createBranch(tempDir, "feature")
			await writeAgencyMetadata(tempDir, {
				version: 1,
				injectedFiles: ["AGENTS.md"],
				baseBranch: "main",
				template: "test-template",
				createdAt: new Date().toISOString(),
			} as any)

			let output = ""
			const originalLog = console.log
			console.log = (msg: string) => {
				output += msg + "\n"
			}

			await runTestEffect(status({ json: true }))

			console.log = originalLog

			const data = JSON.parse(output.trim())
			expect(data.initialized).toBe(true)
			expect(data.branchType).toBe("source")
			expect(data.currentBranch).toBe("feature")
			expect(data.template).toBe("test-template")
			// managedFiles includes base backpack files + injected files
			expect(data.managedFiles).toContain("TASK.md")
			expect(data.managedFiles).toContain("AGENCY.md")
			expect(data.managedFiles).toContain("agency.json")
			expect(data.managedFiles).toContain("AGENTS.md")
			expect(data.baseBranch).toBe("main")
		})

		test("JSON output contains all expected fields", async () => {
			await initAgency(tempDir, "test-template")
			await createBranch(tempDir, "feature")
			await writeAgencyMetadata(tempDir, {
				version: 1,
				injectedFiles: [],
				template: "test-template",
				createdAt: new Date().toISOString(),
			} as any)

			let output = ""
			const originalLog = console.log
			console.log = (msg: string) => {
				output += msg + "\n"
			}

			await runTestEffect(status({ json: true }))

			console.log = originalLog

			const data = JSON.parse(output.trim())
			expect(data).toHaveProperty("initialized")
			expect(data).toHaveProperty("branchType")
			expect(data).toHaveProperty("currentBranch")
			expect(data).toHaveProperty("sourceBranch")
			expect(data).toHaveProperty("emitBranch")
			expect(data).toHaveProperty("correspondingBranchExists")
			expect(data).toHaveProperty("template")
			expect(data).toHaveProperty("managedFiles")
			expect(data).toHaveProperty("baseBranch")
			expect(data).toHaveProperty("createdAt")
		})

		test("JSON output shows not initialized state", async () => {
			let output = ""
			const originalLog = console.log
			console.log = (msg: string) => {
				output += msg + "\n"
			}

			await runTestEffect(status({ json: true }))

			console.log = originalLog

			const data = JSON.parse(output.trim())
			expect(data.initialized).toBe(false)
			expect(data.branchType).toBe("neither")
		})
	})

	describe("error handling", () => {
		test("throws error when not in a git repository", async () => {
			const nonGitDir = await createTempDir()
			process.chdir(nonGitDir)

			await expect(runTestEffect(status({}))).rejects.toThrow(
				"Not in a git repository",
			)

			await cleanupTempDir(nonGitDir)
		})
	})

	describe("silent mode", () => {
		test("silent flag suppresses output", async () => {
			const originalLog = console.log
			let logCalled = false
			console.log = () => {
				logCalled = true
			}

			await runTestEffect(status({ silent: true }))

			console.log = originalLog
			expect(logCalled).toBe(false)
		})
	})

	describe("emit branch behavior", () => {
		test("reads metadata from source branch when on emit branch without agency.json on disk", async () => {
			await initAgency(tempDir, "test-template")

			// Create source branch (agency/feature) with agency.json committed
			await createBranch(tempDir, "agency/feature")
			await writeAgencyMetadata(tempDir, {
				version: 1,
				injectedFiles: ["AGENTS.md", "opencode.json"],
				template: "test-template",
				baseBranch: "main",
				emitBranch: "feature",
				createdAt: new Date().toISOString(),
			} as any)
			// Stage and commit agency.json
			await Bun.spawn(["git", "add", "agency.json"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited
			await createCommit(tempDir, "Feature work")

			// Create emit branch and remove agency.json from working tree
			await createBranch(tempDir, "feature")
			await Bun.spawn(["rm", "agency.json"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited

			let output = ""
			const originalLog = console.log
			console.log = (msg: string) => {
				output += msg + "\n"
			}

			await runTestEffect(status({ json: true }))

			console.log = originalLog

			const data = JSON.parse(output.trim())
			// Verify that we're recognized as on an emit branch
			expect(data.branchType).toBe("emit")
			expect(data.initialized).toBe(true)
			// Verify metadata is correctly read from source branch
			expect(data.baseBranch).toBe("main")
			expect(data.managedFiles).toContain("AGENTS.md")
			expect(data.managedFiles).toContain("opencode.json")
			expect(data.sourceBranch).toBe("agency/feature")
		})

		test("shows correct backpack when on emit branch", async () => {
			await initAgency(tempDir, "test-template")

			// Create source branch (agency/feature) with agency.json committed
			await createBranch(tempDir, "agency/feature")
			await writeAgencyMetadata(tempDir, {
				version: 1,
				injectedFiles: ["AGENTS.md"],
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
			await createCommit(tempDir, "Feature work")

			// Create emit branch and remove agency.json from disk to simulate clean emit branch
			await createBranch(tempDir, "feature")
			await Bun.spawn(["rm", "agency.json"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited

			let output = ""
			const originalLog = console.log
			console.log = (msg: string) => {
				output += msg + "\n"
			}

			await runTestEffect(status({ json: true }))

			console.log = originalLog

			const data = JSON.parse(output.trim())
			expect(data.branchType).toBe("emit")
			expect(data.initialized).toBe(true)
			// Backpack should include injected files from source branch
			expect(data.managedFiles).toContain("AGENTS.md")
			expect(data.managedFiles).toContain("TASK.md")
			expect(data.managedFiles).toContain("AGENCY.md")
			expect(data.managedFiles).toContain("agency.json")
		})
	})
})
