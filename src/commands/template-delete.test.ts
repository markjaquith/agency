import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { templateDelete } from "./template-delete"
import { mkdir, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

describe("template delete command", () => {
	let testDir: string
	let gitRoot: string
	let templateDir: string

	beforeEach(async () => {
		// Create temporary test directory
		testDir = join(tmpdir(), `agency-test-delete-${Date.now()}`)
		await mkdir(testDir, { recursive: true })
		gitRoot = join(testDir, "repo")
		await mkdir(gitRoot, { recursive: true })

		// Initialize git repo
		await Bun.spawn(["git", "init"], {
			cwd: gitRoot,
			stdout: "ignore",
			stderr: "ignore",
		}).exited

		// Set up config dir
		const configDir = join(testDir, "config")
		templateDir = join(configDir, "templates", "test-template")
		await mkdir(templateDir, { recursive: true })

		// Set environment variable for config
		process.env.AGENCY_CONFIG_DIR = configDir

		// Set git config
		await Bun.spawn(["git", "config", "agency.template", "test-template"], {
			cwd: gitRoot,
			stdout: "ignore",
			stderr: "ignore",
		}).exited
	})

	afterEach(async () => {
		// Clean up
		await rm(testDir, { recursive: true, force: true })
		delete process.env.AGENCY_CONFIG_DIR
	})

	test("deletes file from template directory", async () => {
		// Create test file in template
		const testFile = join(templateDir, "test.md")
		await writeFile(testFile, "# Test")

		const originalCwd = process.cwd()
		process.chdir(gitRoot)

		try {
			await templateDelete({ files: ["test.md"], silent: true })

			// Verify file was deleted
			const file = Bun.file(testFile)
			expect(await file.exists()).toBe(false)
		} finally {
			process.chdir(originalCwd)
		}
	})

	test("deletes multiple files", async () => {
		// Create test files in template
		await writeFile(join(templateDir, "file1.md"), "# File 1")
		await writeFile(join(templateDir, "file2.md"), "# File 2")
		await writeFile(join(templateDir, "file3.md"), "# File 3")

		const originalCwd = process.cwd()
		process.chdir(gitRoot)

		try {
			await templateDelete({
				files: ["file1.md", "file2.md"],
				silent: true,
			})

			// Verify files were deleted
			expect(await Bun.file(join(templateDir, "file1.md")).exists()).toBe(false)
			expect(await Bun.file(join(templateDir, "file2.md")).exists()).toBe(false)
			// file3.md should still exist
			expect(await Bun.file(join(templateDir, "file3.md")).exists()).toBe(true)
		} finally {
			process.chdir(originalCwd)
		}
	})

	test("deletes directory recursively", async () => {
		// Create test directory with files
		const docsDir = join(templateDir, "docs")
		await mkdir(docsDir, { recursive: true })
		await writeFile(join(docsDir, "README.md"), "# Docs")
		await writeFile(join(docsDir, "guide.md"), "# Guide")

		const originalCwd = process.cwd()
		process.chdir(gitRoot)

		try {
			await templateDelete({ files: ["docs"], silent: true })

			// Verify directory was deleted
			const dir = Bun.file(docsDir)
			expect(await dir.exists()).toBe(false)
		} finally {
			process.chdir(originalCwd)
		}
	})

	test("handles non-existent files gracefully", async () => {
		const originalCwd = process.cwd()
		process.chdir(gitRoot)

		try {
			// Should not throw error for non-existent file
			await templateDelete({ files: ["nonexistent.md"], silent: true })
		} finally {
			process.chdir(originalCwd)
		}
	})

	test("throws error when no files specified", async () => {
		const originalCwd = process.cwd()
		process.chdir(gitRoot)

		try {
			await expect(templateDelete({ files: [], silent: true })).rejects.toThrow(
				"No files specified",
			)
		} finally {
			process.chdir(originalCwd)
		}
	})

	test("throws error when not in git repository", async () => {
		const nonGitDir = join(testDir, "non-git")
		await mkdir(nonGitDir, { recursive: true })

		const originalCwd = process.cwd()
		process.chdir(nonGitDir)

		try {
			await expect(
				templateDelete({ files: ["test.md"], silent: true }),
			).rejects.toThrow("Not in a git repository")
		} finally {
			process.chdir(originalCwd)
		}
	})

	test("throws error when template not configured", async () => {
		// Remove git config
		await Bun.spawn(["git", "config", "--unset", "agency.template"], {
			cwd: gitRoot,
			stdout: "ignore",
			stderr: "ignore",
		}).exited

		const originalCwd = process.cwd()
		process.chdir(gitRoot)

		try {
			await expect(
				templateDelete({ files: ["test.md"], silent: true }),
			).rejects.toThrow("No template configured")
		} finally {
			process.chdir(originalCwd)
		}
	})
})
