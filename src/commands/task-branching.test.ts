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
		test("creates new agency--some-branch when using --from some-branch with explicit name", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)
			await initAgency(tempDir, "test")

			// Create a feature branch called 'some-branch'
			await runGitCommand(tempDir, ["git", "checkout", "-b", "some-branch"])
			await createFile(tempDir, "feature.txt", "content")
			await runGitCommand(tempDir, ["git", "add", "."])
			await runGitCommand(tempDir, ["git", "commit", "-m", "Add feature"])

			// Run agency task my-feature --from some-branch
			// This should create a NEW branch called agency--my-feature
			await runTestEffect(
				task({
					silent: true,
					emit: "my-feature",
					from: "some-branch",
				}),
			)

			const currentBranch = await getCurrentBranch(tempDir)
			expect(currentBranch).toBe("agency--my-feature")

			// Verify feature.txt exists (came from some-branch)
			const featureFile = await Bun.file(join(tempDir, "feature.txt")).text()
			expect(featureFile).toBe("content")

			// Verify TASK.md was created (agency files added)
			const taskMdExists = await Bun.file(join(tempDir, "TASK.md")).exists()
			expect(taskMdExists).toBe(true)
		})

		test("throws error when agency--some-branch already exists", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)
			await initAgency(tempDir, "test")

			// Create a feature branch called 'some-branch'
			await runGitCommand(tempDir, ["git", "checkout", "-b", "some-branch"])
			await createFile(tempDir, "feature.txt", "content")
			await runGitCommand(tempDir, ["git", "add", "."])
			await runGitCommand(tempDir, ["git", "commit", "-m", "Add feature"])

			// Create agency--my-feature first
			await runTestEffect(
				task({
					silent: true,
					emit: "my-feature",
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
						emit: "my-feature",
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
					emit: "my-task",
					from: "feature-base",
				}),
			)

			const currentBranch = await getCurrentBranch(tempDir)
			expect(currentBranch).toBe("agency--my-task")

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
						emit: "my-task",
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
					emit: "first-task",
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
					emit: "second-task",
					from: "agency--first-task",
				}),
			)

			const currentBranch = await getCurrentBranch(tempDir)
			expect(currentBranch).toBe("agency--second-task")

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
					emit: "unemitted-task",
				}),
			)

			// Go back to main
			await runGitCommand(tempDir, ["git", "checkout", "main"])

			// Try to create task from unemitted agency branch
			await expect(
				runTestEffect(
					task({
						silent: true,
						emit: "second-task",
						from: "agency--unemitted-task",
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
					emit: "my-task",
					from: "feature-current",
				}),
			)

			const currentBranch = await getCurrentBranch(tempDir)
			expect(currentBranch).toBe("agency--my-task")

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
					emit: "first-task",
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
					emit: "second-task",
					from: "agency--first-task",
				}),
			)

			const currentBranch = await getCurrentBranch(tempDir)
			expect(currentBranch).toBe("agency--second-task")

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
					emit: "unemitted-task",
				}),
			)

			// Go back to main
			await runGitCommand(tempDir, ["git", "checkout", "main"])

			// Try to create task from unemitted agency branch
			await expect(
				runTestEffect(
					task({
						silent: true,
						emit: "second-task",
						from: "agency--unemitted-task",
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
						emit: "my-task",
						from: "main",
						fromCurrent: true,
					}),
				),
			).rejects.toThrow("Cannot use both --from and --from-current")
		})
	})

	describe("--from flag branch naming", () => {
		test("agency task --from foo requires explicit branch name in silent mode", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)
			await initAgency(tempDir, "test")

			await runGitCommand(tempDir, ["git", "checkout", "-b", "foo"])
			await runGitCommand(tempDir, ["git", "checkout", "main"])

			await expect(
				runTestEffect(
					task({
						silent: true,
						from: "foo",
					}),
				),
			).rejects.toThrow("Branch name")
		})

		test("agency task out --from foo creates agency--out emitting to out", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)
			await initAgency(tempDir, "test")

			await runGitCommand(tempDir, ["git", "checkout", "-b", "foo"])
			await runGitCommand(tempDir, ["git", "checkout", "main"])

			await runTestEffect(
				task({
					silent: true,
					emit: "out",
					from: "foo",
				}),
			)

			const currentBranch = await getCurrentBranch(tempDir)
			expect(currentBranch).toBe("agency--out")

			const agencyJson = JSON.parse(
				await Bun.file(join(tempDir, "agency.json")).text(),
			)
			expect(agencyJson.emitBranch).toBe("out")
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
					emit: "my-task",
				}),
			)

			const currentBranch = await getCurrentBranch(tempDir)
			expect(currentBranch).toBe("agency--my-task")

			// Verify main.txt exists but other.txt does not
			const mainExists = await Bun.file(join(tempDir, "main.txt")).exists()
			const otherExists = await Bun.file(join(tempDir, "other.txt")).exists()
			expect(mainExists).toBe(true)
			expect(otherExists).toBe(false)
		})
	})

	describe("remote branch preference", () => {
		let remoteDir: string

		beforeEach(async () => {
			// Create a bare repository to act as the "remote"
			remoteDir = await createTempDir()
			await runGitCommand(remoteDir, ["git", "init", "--bare", "-b", "main"])
		})

		afterEach(async () => {
			await cleanupTempDir(remoteDir)
		})

		test("prefers origin/main over local main when remote is ahead", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)
			await initAgency(tempDir, "test")

			// Add the remote
			await runGitCommand(tempDir, [
				"git",
				"remote",
				"add",
				"origin",
				remoteDir,
			])

			// Push current state to remote
			await runGitCommand(tempDir, ["git", "push", "-u", "origin", "main"])

			// Make a commit on local main
			await createFile(tempDir, "local-only.txt", "local content")
			await runGitCommand(tempDir, ["git", "add", "."])
			await runGitCommand(tempDir, ["git", "commit", "-m", "Local-only commit"])

			// Reset local main back to origin/main (simulate local being behind)
			await runGitCommand(tempDir, ["git", "reset", "--hard", "origin/main"])

			// Make a NEW commit on origin/main by pushing from a separate clone
			const cloneDir = await createTempDir()
			await runGitCommand(cloneDir, ["git", "clone", remoteDir, "."])
			await runGitCommand(cloneDir, [
				"git",
				"config",
				"user.email",
				"test@example.com",
			])
			await runGitCommand(cloneDir, ["git", "config", "user.name", "Test User"])
			await createFile(cloneDir, "remote-only.txt", "remote content")
			await runGitCommand(cloneDir, ["git", "add", "."])
			await runGitCommand(cloneDir, [
				"git",
				"commit",
				"-m",
				"Remote-only commit",
			])
			await runGitCommand(cloneDir, ["git", "push", "origin", "main"])
			await cleanupTempDir(cloneDir)

			// Fetch so origin/main is updated but local main stays behind
			await runGitCommand(tempDir, ["git", "fetch", "origin"])

			// Configure agency.mainBranch to "main" (local) and agency.remote to "origin"
			await runGitCommand(tempDir, [
				"git",
				"config",
				"--local",
				"agency.mainBranch",
				"main",
			])
			await runGitCommand(tempDir, [
				"git",
				"config",
				"--local",
				"agency.remote",
				"origin",
			])

			// Create task - should branch from origin/main (which has remote-only.txt)
			await runTestEffect(
				task({
					silent: true,
					emit: "my-task",
				}),
			)

			const currentBranch = await getCurrentBranch(tempDir)
			expect(currentBranch).toBe("agency--my-task")

			// The new branch should have remote-only.txt (from origin/main)
			const remoteFileExists = await Bun.file(
				join(tempDir, "remote-only.txt"),
			).exists()
			expect(remoteFileExists).toBe(true)
		})

		test("falls back to local main when remote branch does not exist", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)
			await initAgency(tempDir, "test")

			// Create a commit on local main
			await createFile(tempDir, "local.txt", "local content")
			await runGitCommand(tempDir, ["git", "add", "."])
			await runGitCommand(tempDir, ["git", "commit", "-m", "Local commit"])

			// Add a remote but don't push (so origin/main doesn't exist)
			await runGitCommand(tempDir, [
				"git",
				"remote",
				"add",
				"origin",
				remoteDir,
			])

			// Configure agency.mainBranch to "main" and agency.remote to "origin"
			await runGitCommand(tempDir, [
				"git",
				"config",
				"--local",
				"agency.mainBranch",
				"main",
			])
			await runGitCommand(tempDir, [
				"git",
				"config",
				"--local",
				"agency.remote",
				"origin",
			])

			// Create task - should fall back to local main since origin/main doesn't exist
			await runTestEffect(
				task({
					silent: true,
					emit: "my-task",
				}),
			)

			const currentBranch = await getCurrentBranch(tempDir)
			expect(currentBranch).toBe("agency--my-task")

			// The new branch should have local.txt
			const localFileExists = await Bun.file(
				join(tempDir, "local.txt"),
			).exists()
			expect(localFileExists).toBe(true)
		})

		test("uses configured remote branch as-is when it already has remote prefix", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)
			await initAgency(tempDir, "test")

			// Add the remote and push
			await runGitCommand(tempDir, [
				"git",
				"remote",
				"add",
				"origin",
				remoteDir,
			])
			await runGitCommand(tempDir, ["git", "push", "-u", "origin", "main"])

			// Configure agency.mainBranch to "origin/main" (already has remote prefix)
			await runGitCommand(tempDir, [
				"git",
				"config",
				"--local",
				"agency.mainBranch",
				"origin/main",
			])

			// Create task
			await runTestEffect(
				task({
					silent: true,
					emit: "my-task",
				}),
			)

			const currentBranch = await getCurrentBranch(tempDir)
			expect(currentBranch).toBe("agency--my-task")
		})
	})
})
