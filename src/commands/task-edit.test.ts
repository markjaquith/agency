import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { join } from "path"
import { taskEdit, task } from "./task"
import {
	createTempDir,
	cleanupTempDir,
	initGitRepo,
	initAgency,
	readFile,
	runTestEffect,
	createFile,
	runGitCommand,
} from "../test-utils"
import { chmod } from "fs/promises"

describe("edit command", () => {
	let tempDir: string
	let originalCwd: string
	let originalConfigDir: string | undefined
	let originalEditor: string | undefined

	beforeEach(async () => {
		tempDir = await createTempDir()
		originalCwd = process.cwd()
		originalConfigDir = process.env.AGENCY_CONFIG_DIR
		originalEditor = process.env.EDITOR
		// Use a temp config dir to avoid interference from user's actual config
		process.env.AGENCY_CONFIG_DIR = await createTempDir()
	})

	afterEach(async () => {
		process.chdir(originalCwd)
		if (originalConfigDir !== undefined) {
			process.env.AGENCY_CONFIG_DIR = originalConfigDir
		} else {
			delete process.env.AGENCY_CONFIG_DIR
		}
		if (originalEditor !== undefined) {
			process.env.EDITOR = originalEditor
		} else {
			delete process.env.EDITOR
		}
		if (
			process.env.AGENCY_CONFIG_DIR &&
			process.env.AGENCY_CONFIG_DIR !== originalConfigDir
		) {
			await cleanupTempDir(process.env.AGENCY_CONFIG_DIR)
		}
		await cleanupTempDir(tempDir)
	})

	test("throws error when not in git repo", async () => {
		process.chdir(tempDir)

		await expect(runTestEffect(taskEdit({ silent: true }))).rejects.toThrow(
			"Not in a git repository",
		)
	})

	test("throws error when TASK.md does not exist", async () => {
		await initGitRepo(tempDir)
		process.chdir(tempDir)

		await expect(runTestEffect(taskEdit({ silent: true }))).rejects.toThrow(
			"TASK.md not found in repository root",
		)
	})

	test("opens TASK.md in editor when it exists", async () => {
		await initGitRepo(tempDir)
		process.chdir(tempDir)

		// Initialize to create TASK.md
		await initAgency(tempDir, "test-task")

		await runTestEffect(task({ silent: true, emit: "test-feature" }))

		// Use a mock editor that just exits successfully
		process.env.EDITOR = "true" // 'true' is a command that always exits with code 0

		// Should not throw
		await expect(
			runTestEffect(taskEdit({ silent: true })),
		).resolves.toBeUndefined()
	})

	test("uses EDITOR environment variable", async () => {
		await initGitRepo(tempDir)
		process.chdir(tempDir)

		// Initialize to create TASK.md
		await initAgency(tempDir, "test-task")

		await runTestEffect(task({ silent: true, emit: "test-feature" }))

		// Use 'true' command which exits successfully without doing anything
		process.env.EDITOR = "true"

		// Should complete without error
		await expect(
			runTestEffect(taskEdit({ silent: true })),
		).resolves.toBeUndefined()
	})

	test("uses VISUAL environment variable over EDITOR", async () => {
		await initGitRepo(tempDir)
		process.chdir(tempDir)

		// Initialize to create TASK.md
		await initAgency(tempDir, "test-task")

		await runTestEffect(task({ silent: true, emit: "test-feature" }))

		// Set VISUAL to 'true' and EDITOR to 'false'
		// If VISUAL is used (correct), it should succeed
		// If EDITOR is used (incorrect), it should fail
		process.env.VISUAL = "true"
		process.env.EDITOR = "false"

		// Should complete without error, proving VISUAL was used
		await expect(
			runTestEffect(taskEdit({ silent: true })),
		).resolves.toBeUndefined()
	})

	test("throws error when editor exits with non-zero code", async () => {
		await initGitRepo(tempDir)
		process.chdir(tempDir)

		// Initialize to create TASK.md
		await initAgency(tempDir, "test-task")

		await runTestEffect(task({ silent: true, emit: "test-feature" }))

		// Clear VISUAL to ensure EDITOR is used
		delete process.env.VISUAL
		// Use a mock editor that fails
		process.env.EDITOR = "false" // 'false' is a command that always exits with code 1

		await expect(runTestEffect(taskEdit({ silent: true }))).rejects.toThrow(
			"Editor exited with code",
		)
	})

	test("commits TASK.md with 'chore: agency edit' when file is modified", async () => {
		await initGitRepo(tempDir)
		process.chdir(tempDir)

		// Initialize to create TASK.md
		await initAgency(tempDir, "test-task")
		await runTestEffect(task({ silent: true, emit: "test-feature" }))

		// Get initial commit count
		const result = Bun.spawnSync({
			cmd: ["git", "rev-list", "--count", "HEAD"],
			cwd: tempDir,
			stdout: "pipe",
		})
		const initialCommits = new TextDecoder().decode(result.stdout).trim()

		// Use a script that modifies TASK.md
		const scriptPath = join(tempDir, "edit-script.sh")
		await createFile(
			tempDir,
			"edit-script.sh",
			'#!/bin/bash\necho "Updated task" >> "$1"\n',
		)
		await chmod(scriptPath, 0o755)
		process.env.EDITOR = scriptPath

		// Run edit command
		await runTestEffect(taskEdit({ silent: true }))

		// Check that a new commit was created
		const finalResult = Bun.spawnSync({
			cmd: ["git", "rev-list", "--count", "HEAD"],
			cwd: tempDir,
			stdout: "pipe",
		})
		const finalCommits = new TextDecoder().decode(finalResult.stdout).trim()
		expect(Number.parseInt(finalCommits)).toBe(
			Number.parseInt(initialCommits) + 1,
		)

		// Check the commit message
		const msgResult = Bun.spawnSync({
			cmd: ["git", "log", "-1", "--format=%s"],
			cwd: tempDir,
			stdout: "pipe",
		})
		const commitMessage = new TextDecoder().decode(msgResult.stdout).trim()
		expect(commitMessage).toBe("chore: agency edit")

		// Check that only TASK.md was committed
		const filesResult = Bun.spawnSync({
			cmd: ["git", "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"],
			cwd: tempDir,
			stdout: "pipe",
		})
		const filesInCommit = new TextDecoder().decode(filesResult.stdout).trim()
		expect(filesInCommit).toBe("TASK.md")
	})

	test("does not commit when TASK.md is not modified", async () => {
		await initGitRepo(tempDir)
		process.chdir(tempDir)

		// Initialize to create TASK.md
		await initAgency(tempDir, "test-task")
		await runTestEffect(task({ silent: true, emit: "test-feature" }))

		// Get initial commit count
		const result = Bun.spawnSync({
			cmd: ["git", "rev-list", "--count", "HEAD"],
			cwd: tempDir,
			stdout: "pipe",
		})
		const initialCommits = new TextDecoder().decode(result.stdout).trim()

		// Use a mock editor that doesn't modify the file
		process.env.EDITOR = "true"

		// Run edit command
		await runTestEffect(taskEdit({ silent: true }))

		// Check that no new commit was created
		const finalResult = Bun.spawnSync({
			cmd: ["git", "rev-list", "--count", "HEAD"],
			cwd: tempDir,
			stdout: "pipe",
		})
		const finalCommits = new TextDecoder().decode(finalResult.stdout).trim()
		expect(Number.parseInt(finalCommits)).toBe(Number.parseInt(initialCommits))
	})
})
