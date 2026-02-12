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
	getGitOutput,
} from "../test-utils"

describe("task --continue --squash", () => {
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

	test("fails when --squash is used without --continue", async () => {
		await initGitRepo(tempDir)
		process.chdir(tempDir)

		await initAgency(tempDir, "test")

		await expect(
			runTestEffect(task({ silent: true, squash: true, emit: "some-branch" })),
		).rejects.toThrow("--squash flag can only be used with --continue")
	})

	test("squashes emitted commits into a single commit on new branch", async () => {
		await initGitRepo(tempDir)
		process.chdir(tempDir)

		await initAgency(tempDir, "test")

		// Create a task branch with agency files
		await runTestEffect(
			task({ silent: true, emit: "feature-v1", task: "Original task" }),
		)

		// Add two code commits to the branch
		await Bun.write(join(tempDir, "feature-a.txt"), "feature A content")
		await Bun.spawn(["git", "add", "feature-a.txt"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited
		await Bun.spawn(["git", "commit", "--no-verify", "-m", "Add feature A"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited

		await Bun.write(join(tempDir, "feature-b.txt"), "feature B content")
		await Bun.spawn(["git", "add", "feature-b.txt"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited
		await Bun.spawn(["git", "commit", "--no-verify", "-m", "Add feature B"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited

		// Now continue with squash
		await runTestEffect(
			task({
				silent: true,
				continue: true,
				squash: true,
				emit: "feature-v2",
				task: "New task for v2",
			}),
		)

		// Verify we're on the new branch
		const newBranch = await getCurrentBranch(tempDir)
		expect(newBranch).toBe("agency--feature-v2")

		// Verify both feature files exist (squash brought them in)
		expect(await fileExists(join(tempDir, "feature-a.txt"))).toBe(true)
		expect(await fileExists(join(tempDir, "feature-b.txt"))).toBe(true)

		// Verify agency files exist
		expect(await fileExists(join(tempDir, "agency.json"))).toBe(true)
		expect(await fileExists(join(tempDir, "TASK.md"))).toBe(true)
		expect(await fileExists(join(tempDir, "AGENCY.md"))).toBe(true)

		// Verify TASK.md has FRESH content (not the old "Original task")
		const taskContent = await readFile(join(tempDir, "TASK.md"))
		expect(taskContent).toContain("New task for v2")
		expect(taskContent).not.toContain("Original task")

		// Verify agency.json has updated emitBranch
		const agencyJson = JSON.parse(await readFile(join(tempDir, "agency.json")))
		expect(agencyJson.emitBranch).toBe("feature-v2")

		// Verify commit history: should be initial commit + squash commit + agency files commit
		// (not the individual "Add feature A" and "Add feature B" commits)
		const logOutput = await getGitOutput(tempDir, [
			"log",
			"--oneline",
			"--format=%s",
		])
		const commits = logOutput.trim().split("\n")

		// Should NOT contain individual feature commits
		expect(logOutput).not.toContain("Add feature A")
		expect(logOutput).not.toContain("Add feature B")

		// Should contain a squash commit
		expect(logOutput).toContain("squash: prior work from feature-v1")
	})

	test("creates fresh TASK.md with default placeholder when no task provided in silent mode", async () => {
		await initGitRepo(tempDir)
		process.chdir(tempDir)

		await initAgency(tempDir, "test")

		// Create a task branch
		await runTestEffect(
			task({ silent: true, emit: "feature-v1", task: "Old task" }),
		)

		// Add a code commit
		await Bun.write(join(tempDir, "code.txt"), "code content")
		await Bun.spawn(["git", "add", "code.txt"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited
		await Bun.spawn(["git", "commit", "--no-verify", "-m", "Add code"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited

		// Continue with squash but no --task option (silent mode)
		await runTestEffect(
			task({
				silent: true,
				continue: true,
				squash: true,
				emit: "feature-v2",
			}),
		)

		// TASK.md should have the default placeholder, not the old task
		const taskContent = await readFile(join(tempDir, "TASK.md"))
		expect(taskContent).toContain("{task}")
		expect(taskContent).not.toContain("Old task")
	})

	test("handles empty squash when old branch has no code commits", async () => {
		await initGitRepo(tempDir)
		process.chdir(tempDir)

		await initAgency(tempDir, "test")

		// Create a task branch WITHOUT any code commits
		await runTestEffect(
			task({ silent: true, emit: "feature-v1", task: "Just agency files" }),
		)

		// Continue with squash - should succeed even with no code changes
		await runTestEffect(
			task({
				silent: true,
				continue: true,
				squash: true,
				emit: "feature-v2",
				task: "New task",
			}),
		)

		// Verify we're on the new branch
		const newBranch = await getCurrentBranch(tempDir)
		expect(newBranch).toBe("agency--feature-v2")

		// Verify agency files exist
		expect(await fileExists(join(tempDir, "agency.json"))).toBe(true)
		expect(await fileExists(join(tempDir, "TASK.md"))).toBe(true)

		// Verify fresh TASK.md
		const taskContent = await readFile(join(tempDir, "TASK.md"))
		expect(taskContent).toContain("New task")
	})

	test("preserves other agency files while creating fresh TASK.md", async () => {
		await initGitRepo(tempDir)
		process.chdir(tempDir)

		await initAgency(tempDir, "test")

		// Create a task branch
		await runTestEffect(
			task({ silent: true, emit: "feature-v1", task: "Old task" }),
		)

		// Read the original AGENCY.md content
		const originalAgencyMd = await readFile(join(tempDir, "AGENCY.md"))

		// Add a code commit
		await Bun.write(join(tempDir, "code.txt"), "code")
		await Bun.spawn(["git", "add", "code.txt"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited
		await Bun.spawn(["git", "commit", "--no-verify", "-m", "Add code"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited

		// Continue with squash
		await runTestEffect(
			task({
				silent: true,
				continue: true,
				squash: true,
				emit: "feature-v2",
				task: "New task",
			}),
		)

		// AGENCY.md should be carried forward (not fresh)
		const newAgencyMd = await readFile(join(tempDir, "AGENCY.md"))
		expect(newAgencyMd).toBe(originalAgencyMd)

		// TASK.md should be fresh
		const taskContent = await readFile(join(tempDir, "TASK.md"))
		expect(taskContent).toContain("New task")
		expect(taskContent).not.toContain("Old task")

		// opencode.json should be carried forward
		expect(await fileExists(join(tempDir, "opencode.json"))).toBe(true)
	})
})
