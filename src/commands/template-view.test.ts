import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { templateView } from "./template-view"
import { mkdir, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { runTestEffect } from "../test-utils"

describe("template view command", () => {
	let testDir: string
	let gitRoot: string
	let templateDir: string

	beforeEach(async () => {
		// Create temporary test directory
		testDir = join(tmpdir(), `agency-test-view-${Date.now()}`)
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

	test("views file from template directory", async () => {
		// Create test file in template
		const content = "# Test File\n\nThis is a test."
		const testFile = join(templateDir, "test.md")
		await writeFile(testFile, content)

		const originalCwd = process.cwd()
		process.chdir(gitRoot)

		try {
			// Just verify the command doesn't throw - output goes to stdout
			await runTestEffect(templateView({ file: "test.md", silent: true }))

			// Verify the file exists and has expected content
			const fileContent = await Bun.file(testFile).text()
			expect(fileContent).toContain("# Test File")
			expect(fileContent).toContain("This is a test.")
		} finally {
			process.chdir(originalCwd)
		}
	})

	test("views file in subdirectory", async () => {
		// Create test file in subdirectory
		const docsDir = join(templateDir, "docs")
		await mkdir(docsDir, { recursive: true })
		const content = "# Documentation\n\nDocs content."
		const testFile = join(docsDir, "README.md")
		await writeFile(testFile, content)

		const originalCwd = process.cwd()
		process.chdir(gitRoot)

		try {
			// Just verify the command doesn't throw - output goes to stdout
			await runTestEffect(
				templateView({ file: "docs/README.md", silent: true }),
			)

			// Verify the file exists and has expected content
			const fileContent = await Bun.file(testFile).text()
			expect(fileContent).toContain("# Documentation")
			expect(fileContent).toContain("Docs content.")
		} finally {
			process.chdir(originalCwd)
		}
	})

	test("throws error when file does not exist", async () => {
		const originalCwd = process.cwd()
		process.chdir(gitRoot)

		try {
			await expect(
				runTestEffect(templateView({ file: "nonexistent.md", silent: true })),
			).rejects.toThrow("does not exist in template")
		} finally {
			process.chdir(originalCwd)
		}
	})

	test("throws error when no file specified", async () => {
		const originalCwd = process.cwd()
		process.chdir(gitRoot)

		try {
			await expect(
				runTestEffect(templateView({ silent: true })),
			).rejects.toThrow("File path is required")
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
				runTestEffect(templateView({ file: "test.md", silent: true })),
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
				runTestEffect(templateView({ file: "test.md", silent: true })),
			).rejects.toThrow("Repository not initialized")
		} finally {
			process.chdir(originalCwd)
		}
	})
})
