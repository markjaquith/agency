import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { join } from "path"
import { taskEdit, task } from "./task"
import {
	createTempDir,
	cleanupTempDir,
	initGitRepo,
	initAgency,
	readFile,
} from "../test-utils"

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

		await expect(taskEdit({ silent: true })).rejects.toThrow(
			"Not in a git repository",
		)
	})

	test("throws error when TASK.md does not exist", async () => {
		await initGitRepo(tempDir)
		process.chdir(tempDir)

		await expect(taskEdit({ silent: true })).rejects.toThrow(
			"TASK.md not found in repository root",
		)
	})

	test("opens TASK.md in editor when it exists", async () => {
		await initGitRepo(tempDir)
		process.chdir(tempDir)

		// Initialize to create TASK.md
		await initAgency(tempDir, "test-task")

		await task({ silent: true, branch: "test-feature" })

		// Use a mock editor that just exits successfully
		process.env.EDITOR = "true" // 'true' is a command that always exits with code 0

		// Should not throw
		await expect(taskEdit({ silent: true })).resolves.toBeUndefined()
	})

	test("uses EDITOR environment variable", async () => {
		await initGitRepo(tempDir)
		process.chdir(tempDir)

		// Initialize to create TASK.md
		await initAgency(tempDir, "test-task")

		await task({ silent: true, branch: "test-feature" })

		// Use 'true' command which exits successfully without doing anything
		process.env.EDITOR = "true"

		// Should complete without error
		await expect(taskEdit({ silent: true })).resolves.toBeUndefined()
	})

	test("uses VISUAL environment variable over EDITOR", async () => {
		await initGitRepo(tempDir)
		process.chdir(tempDir)

		// Initialize to create TASK.md
		await initAgency(tempDir, "test-task")

		await task({ silent: true, branch: "test-feature" })

		// Set VISUAL to 'true' and EDITOR to 'false'
		// If VISUAL is used (correct), it should succeed
		// If EDITOR is used (incorrect), it should fail
		process.env.VISUAL = "true"
		process.env.EDITOR = "false"

		// Should complete without error, proving VISUAL was used
		await expect(taskEdit({ silent: true })).resolves.toBeUndefined()
	})

	test("throws error when editor exits with non-zero code", async () => {
		await initGitRepo(tempDir)
		process.chdir(tempDir)

		// Initialize to create TASK.md
		await initAgency(tempDir, "test-task")

		await task({ silent: true, branch: "test-feature" })

		// Clear VISUAL to ensure EDITOR is used
		delete process.env.VISUAL
		// Use a mock editor that fails
		process.env.EDITOR = "false" // 'false' is a command that always exits with code 1

		await expect(taskEdit({ silent: true })).rejects.toThrow(
			"Editor exited with code",
		)
	})
})
