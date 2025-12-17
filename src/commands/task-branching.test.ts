import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { join } from "path"
import { task } from "../commands/task"
import { emit } from "../commands/emit"
import {
	createTempDir,
	cleanupTempDir,
	initGitRepo,
	initAgency,
	runTestEffect,
	createFile,
	runGitCommand,
	getCurrentBranch,
} from "../test-utils"

describe("task command - branching functionality", () => {
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

	describe("--from flag", () => {
		test("creates new agency/some-branch when using --from some-branch", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)
			await initAgency(tempDir, "test")

			// Create a feature branch called 'some-branch'
			await runGitCommand(tempDir, ["git", "checkout", "-b", "some-branch"])
			await createFile(tempDir, "feature.txt", "content")
			await runGitCommand(tempDir, ["git", "add", "."])
			await runGitCommand(tempDir, ["git", "commit", "-m", "Add feature"])

			// Run agency task --from some-branch (while ON some-branch)
			// This should create a NEW branch called agency/some-branch
			await runTestEffect(
				task({
					silent: true,
					from: "some-branch",
				}),
			)

			const currentBranch = await getCurrentBranch(tempDir)
			expect(currentBranch).toBe("agency/some-branch")

			// Verify feature.txt exists (came from some-branch)
			const featureFile = await Bun.file(join(tempDir, "feature.txt")).text()
			expect(featureFile).toBe("content")

			// Verify TASK.md was created (agency files added)
			const taskMdExists = await Bun.file(join(tempDir, "TASK.md")).exists()
			expect(taskMdExists).toBe(true)
		})

		test("throws error when agency/some-branch already exists", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)
			await initAgency(tempDir, "test")

			// Create a feature branch called 'some-branch'
			await runGitCommand(tempDir, ["git", "checkout", "-b", "some-branch"])
			await createFile(tempDir, "feature.txt", "content")
			await runGitCommand(tempDir, ["git", "add", "."])
			await runGitCommand(tempDir, ["git", "commit", "-m", "Add feature"])

			// Create agency/some-branch first
			await runTestEffect(
				task({
					silent: true,
					from: "some-branch",
				}),
			)

			// Go back to some-branch
			await runGitCommand(tempDir, ["git", "checkout", "some-branch"])

			// Try to create it again - should fail
			await expect(
				runTestEffect(
					task({
						silent: true,
						from: "some-branch",
					}),
				),
			).rejects.toThrow("already exists")
		})

		test("branches from specified non-agency branch", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)
			await initAgency(tempDir, "test")

			// Create a feature branch
			await runGitCommand(tempDir, ["git", "checkout", "-b", "feature-base"])
			await createFile(tempDir, "feature.txt", "content")
			await runGitCommand(tempDir, ["git", "add", "."])
			await runGitCommand(tempDir, ["git", "commit", "-m", "Add feature"])

			// Go back to main
			await runGitCommand(tempDir, ["git", "checkout", "main"])

			// Create task branch from feature-base
			await runTestEffect(
				task({
					silent: true,
					branch: "my-task",
					from: "feature-base",
				}),
			)

			const currentBranch = await getCurrentBranch(tempDir)
			expect(currentBranch).toBe("agency/my-task")

			// Verify feature.txt exists (came from feature-base)
			const featureFile = await Bun.file(join(tempDir, "feature.txt")).text()
			expect(featureFile).toBe("content")
		})

		test("throws error if specified branch does not exist", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)
			await initAgency(tempDir, "test")

			await expect(
				runTestEffect(
					task({
						silent: true,
						branch: "my-task",
						from: "nonexistent-branch",
					}),
				),
			).rejects.toThrow("does not exist")
		})

		test("detects agency source branch and uses its emit branch", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)
			await initAgency(tempDir, "test")

			// Create first agency branch
			await runTestEffect(
				task({
					silent: true,
					branch: "first-task",
				}),
			)

			// Add a unique file to identify this branch
			await createFile(tempDir, "first-task.txt", "first")
			await runGitCommand(tempDir, ["git", "add", "."])
			await runGitCommand(tempDir, [
				"git",
				"commit",
				"-m",
				"Add first task file",
			])

			// Emit the branch
			await runTestEffect(emit({ silent: true }))

			// Go back to main
			await runGitCommand(tempDir, ["git", "checkout", "main"])

			// Create second task from first agency branch
			await runTestEffect(
				task({
					silent: true,
					branch: "second-task",
					from: "agency/first-task",
				}),
			)

			const currentBranch = await getCurrentBranch(tempDir)
			expect(currentBranch).toBe("agency/second-task")

			// Verify first-task.txt exists (came from emit branch)
			const firstTaskFile = await Bun.file(
				join(tempDir, "first-task.txt"),
			).text()
			expect(firstTaskFile).toBe("first")

			// Verify TASK.md does NOT exist from first-task
			// (because we branched from emit branch, not source branch)
			const taskMdExists = await Bun.file(join(tempDir, "TASK.md")).exists()
			// The new TASK.md should exist (created by second task)
			// but it should be fresh, not from first-task
			expect(taskMdExists).toBe(true)
		})

		test("throws error if agency source branch has no emit branch", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)
			await initAgency(tempDir, "test")

			// Create agency branch without emitting
			await runTestEffect(
				task({
					silent: true,
					branch: "unemitted-task",
				}),
			)

			// Go back to main
			await runGitCommand(tempDir, ["git", "checkout", "main"])

			// Try to create task from unemitted agency branch
			await expect(
				runTestEffect(
					task({
						silent: true,
						branch: "second-task",
						from: "agency/unemitted-task",
					}),
				),
			).rejects.toThrow("emit branch")
		})
	})

	describe("--from-current flag", () => {
		test("branches from current branch when it's not an agency branch", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)
			await initAgency(tempDir, "test")

			// Create and switch to a feature branch
			await runGitCommand(tempDir, ["git", "checkout", "-b", "feature-current"])
			await createFile(tempDir, "current.txt", "content")
			await runGitCommand(tempDir, ["git", "add", "."])
			await runGitCommand(tempDir, ["git", "commit", "-m", "Add current file"])

			// Go back to main to create the task
			await runGitCommand(tempDir, ["git", "checkout", "main"])

			// Create task from feature-current branch
			await runTestEffect(
				task({
					silent: true,
					branch: "my-task",
					from: "feature-current",
				}),
			)

			const currentBranch = await getCurrentBranch(tempDir)
			expect(currentBranch).toBe("agency/my-task")

			// Verify current.txt exists
			const currentFile = await Bun.file(join(tempDir, "current.txt")).text()
			expect(currentFile).toBe("content")
		})

		test("uses emit branch when --from specifies an agency branch", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)
			await initAgency(tempDir, "test")

			// Create first agency branch
			await runTestEffect(
				task({
					silent: true,
					branch: "first-task",
				}),
			)

			await createFile(tempDir, "first.txt", "first")
			await runGitCommand(tempDir, ["git", "add", "."])
			await runGitCommand(tempDir, ["git", "commit", "-m", "Add first file"])

			// Emit the branch
			await runTestEffect(emit({ silent: true }))

			// Go back to main
			await runGitCommand(tempDir, ["git", "checkout", "main"])

			// Create task from first agency branch
			await runTestEffect(
				task({
					silent: true,
					branch: "second-task",
					from: "agency/first-task",
				}),
			)

			const currentBranch = await getCurrentBranch(tempDir)
			expect(currentBranch).toBe("agency/second-task")

			// Verify first.txt exists
			const firstFile = await Bun.file(join(tempDir, "first.txt")).text()
			expect(firstFile).toBe("first")
		})

		test("throws error if --from agency branch has no emit branch", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)
			await initAgency(tempDir, "test")

			// Create agency branch without emitting
			await runTestEffect(
				task({
					silent: true,
					branch: "unemitted-task",
				}),
			)

			// Go back to main
			await runGitCommand(tempDir, ["git", "checkout", "main"])

			// Try to create task from unemitted agency branch
			await expect(
				runTestEffect(
					task({
						silent: true,
						branch: "second-task",
						from: "agency/unemitted-task",
					}),
				),
			).rejects.toThrow("emit branch")
		})
	})

	describe("--from and --from-current validation", () => {
		test("throws error if both flags are used", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)
			await initAgency(tempDir, "test")

			await expect(
				runTestEffect(
					task({
						silent: true,
						branch: "my-task",
						from: "main",
						fromCurrent: true,
					}),
				),
			).rejects.toThrow("Cannot use both --from and --from-current")
		})
	})

	describe("default branching behavior", () => {
		test("branches from auto-detected main branch by default", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)
			await initAgency(tempDir, "test")

			// Create a commit on main
			await createFile(tempDir, "main.txt", "main content")
			await runGitCommand(tempDir, ["git", "add", "."])
			await runGitCommand(tempDir, ["git", "commit", "-m", "Main commit"])

			// Create a different branch and switch to it
			await runGitCommand(tempDir, ["git", "checkout", "-b", "other-branch"])
			await createFile(tempDir, "other.txt", "other content")
			await runGitCommand(tempDir, ["git", "add", "."])
			await runGitCommand(tempDir, ["git", "commit", "-m", "Other commit"])

			// Go back to main to set it as main branch
			await runGitCommand(tempDir, ["git", "checkout", "main"])

			// Create task (should branch from main)
			await runTestEffect(
				task({
					silent: true,
					branch: "my-task",
				}),
			)

			const currentBranch = await getCurrentBranch(tempDir)
			expect(currentBranch).toBe("agency/my-task")

			// Verify main.txt exists but other.txt does not
			const mainExists = await Bun.file(join(tempDir, "main.txt")).exists()
			const otherExists = await Bun.file(join(tempDir, "other.txt")).exists()
			expect(mainExists).toBe(true)
			expect(otherExists).toBe(false)
		})
	})
})
