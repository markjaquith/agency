import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { join } from "path"
import { task } from "./task"
import {
	createTempDir,
	cleanupTempDir,
	initGitRepo,
	initAgency,
	fileExists,
	readFile,
	runTestEffect,
	getCurrentBranch,
} from "../test-utils"

describe("task --continue", () => {
	let tempDir: string
	let originalCwd: string
	let originalConfigDir: string | undefined

	beforeEach(async () => {
		tempDir = await createTempDir()
		originalCwd = process.cwd()
		originalConfigDir = process.env.AGENCY_CONFIG_DIR
		process.env.AGENCY_CONFIG_DIR = await createTempDir()
	})

	afterEach(async () => {
		process.chdir(originalCwd)
		if (originalConfigDir !== undefined) {
			process.env.AGENCY_CONFIG_DIR = originalConfigDir
		} else {
			delete process.env.AGENCY_CONFIG_DIR
		}
		if (
			process.env.AGENCY_CONFIG_DIR &&
			process.env.AGENCY_CONFIG_DIR !== originalConfigDir
		) {
			await cleanupTempDir(process.env.AGENCY_CONFIG_DIR)
		}
		await cleanupTempDir(tempDir)
	})

	test("fails when not on a branch with agency.json", async () => {
		await initGitRepo(tempDir)
		process.chdir(tempDir)

		await initAgency(tempDir, "test")

		// Try to continue without agency files
		await expect(
			runTestEffect(
				task({ silent: true, continue: true, branch: "new-feature" }),
			),
		).rejects.toThrow("No agency.json found")
	})

	test("fails when branch name not provided in silent mode", async () => {
		await initGitRepo(tempDir)
		process.chdir(tempDir)

		await initAgency(tempDir, "test")

		// First create a task branch with agency files
		await runTestEffect(task({ silent: true, branch: "original-feature" }))

		// Try to continue without branch name
		await expect(
			runTestEffect(task({ silent: true, continue: true })),
		).rejects.toThrow("Branch name is required")
	})

	test("creates new branch with agency files from current branch", async () => {
		await initGitRepo(tempDir)
		process.chdir(tempDir)

		await initAgency(tempDir, "test")

		// Create a task branch with agency files
		await runTestEffect(
			task({ silent: true, branch: "original-feature", task: "Original task" }),
		)

		// Verify we're on the source branch
		const originalBranch = await getCurrentBranch(tempDir)
		expect(originalBranch).toBe("agency/original-feature")

		// Read the original TASK.md
		const originalTaskContent = await readFile(join(tempDir, "TASK.md"))
		expect(originalTaskContent).toContain("Original task")

		// Now continue to a new branch
		await runTestEffect(
			task({
				silent: true,
				continue: true,
				branch: "continued-feature",
			}),
		)

		// Verify we're on the new branch
		const newBranch = await getCurrentBranch(tempDir)
		expect(newBranch).toBe("agency/continued-feature")

		// Verify agency files were copied
		expect(await fileExists(join(tempDir, "agency.json"))).toBe(true)
		expect(await fileExists(join(tempDir, "TASK.md"))).toBe(true)
		expect(await fileExists(join(tempDir, "AGENCY.md"))).toBe(true)

		// Verify TASK.md content was preserved
		const newTaskContent = await readFile(join(tempDir, "TASK.md"))
		expect(newTaskContent).toContain("Original task")
	})

	test("updates emitBranch in agency.json", async () => {
		await initGitRepo(tempDir)
		process.chdir(tempDir)

		await initAgency(tempDir, "test")

		// Create a task branch
		await runTestEffect(task({ silent: true, branch: "feature-v1" }))

		// Read original agency.json
		const originalAgencyJson = JSON.parse(
			await readFile(join(tempDir, "agency.json")),
		)
		expect(originalAgencyJson.emitBranch).toBe("feature-v1")

		// Continue to new branch
		await runTestEffect(
			task({ silent: true, continue: true, branch: "feature-v2" }),
		)

		// Read new agency.json
		const newAgencyJson = JSON.parse(
			await readFile(join(tempDir, "agency.json")),
		)
		expect(newAgencyJson.emitBranch).toBe("feature-v2")
	})

	test("fails when new branch already exists", async () => {
		await initGitRepo(tempDir)
		process.chdir(tempDir)

		await initAgency(tempDir, "test")

		// Create a task branch
		await runTestEffect(task({ silent: true, branch: "feature-v1" }))

		// Create another branch that would conflict
		await Bun.spawn(["git", "branch", "agency/feature-v2"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited

		// Try to continue to the existing branch name
		await expect(
			runTestEffect(
				task({ silent: true, continue: true, branch: "feature-v2" }),
			),
		).rejects.toThrow("already exists")
	})

	test("copies injected files from metadata", async () => {
		await initGitRepo(tempDir)
		process.chdir(tempDir)

		await initAgency(tempDir, "test")

		// Create a task branch
		await runTestEffect(task({ silent: true, branch: "feature-v1" }))

		// Verify opencode.json exists (it's in injectedFiles)
		expect(await fileExists(join(tempDir, "opencode.json"))).toBe(true)

		// Continue to new branch
		await runTestEffect(
			task({ silent: true, continue: true, branch: "feature-v2" }),
		)

		// Verify opencode.json was copied
		expect(await fileExists(join(tempDir, "opencode.json"))).toBe(true)
	})

	test("new branch is created from main", async () => {
		await initGitRepo(tempDir)
		process.chdir(tempDir)

		await initAgency(tempDir, "test")

		// Create a task branch and add a file
		await runTestEffect(task({ silent: true, branch: "feature-v1" }))

		// Add a file that's NOT in agency files
		await Bun.write(join(tempDir, "feature-specific.txt"), "feature content")
		await Bun.spawn(["git", "add", "feature-specific.txt"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited
		await Bun.spawn(
			["git", "commit", "--no-verify", "-m", "Add feature file"],
			{
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			},
		).exited

		// Continue to new branch
		await runTestEffect(
			task({ silent: true, continue: true, branch: "feature-v2" }),
		)

		// The new branch should be based on main, not on the old feature branch
		// So feature-specific.txt should NOT exist
		expect(await fileExists(join(tempDir, "feature-specific.txt"))).toBe(false)

		// But agency files should exist
		expect(await fileExists(join(tempDir, "agency.json"))).toBe(true)
	})

	test("supports --from flag to specify base branch", async () => {
		await initGitRepo(tempDir)
		process.chdir(tempDir)

		// Create a develop branch
		await Bun.spawn(["git", "checkout", "-b", "develop"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited

		// Add a file to develop
		await Bun.write(join(tempDir, "develop-feature.txt"), "develop content")
		await Bun.spawn(["git", "add", "develop-feature.txt"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited
		await Bun.spawn(
			["git", "commit", "--no-verify", "-m", "Add develop file"],
			{
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			},
		).exited

		// Go back to main
		await Bun.spawn(["git", "checkout", "main"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited

		await initAgency(tempDir, "test")

		// Create a task branch
		await runTestEffect(task({ silent: true, branch: "feature-v1" }))

		// Continue to new branch from develop
		await runTestEffect(
			task({
				silent: true,
				continue: true,
				branch: "feature-v2",
				from: "develop",
			}),
		)

		// The new branch should be based on develop
		// So develop-feature.txt should exist
		expect(await fileExists(join(tempDir, "develop-feature.txt"))).toBe(true)

		// And agency files should also exist
		expect(await fileExists(join(tempDir, "agency.json"))).toBe(true)
	})

	test("preserves createdAt in agency.json but updates it", async () => {
		await initGitRepo(tempDir)
		process.chdir(tempDir)

		await initAgency(tempDir, "test")

		// Create a task branch
		await runTestEffect(task({ silent: true, branch: "feature-v1" }))

		// Read original agency.json
		const originalAgencyJson = JSON.parse(
			await readFile(join(tempDir, "agency.json")),
		)
		const originalCreatedAt = originalAgencyJson.createdAt

		// Wait a bit to ensure time difference
		await new Promise((resolve) => setTimeout(resolve, 10))

		// Continue to new branch
		await runTestEffect(
			task({ silent: true, continue: true, branch: "feature-v2" }),
		)

		// Read new agency.json
		const newAgencyJson = JSON.parse(
			await readFile(join(tempDir, "agency.json")),
		)
		const newCreatedAt = newAgencyJson.createdAt

		// createdAt should be updated (different from original)
		expect(newCreatedAt).not.toBe(originalCreatedAt)
	})
})
