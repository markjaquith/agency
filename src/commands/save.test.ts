import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { join } from "path"
import { save } from "./save"
import { task } from "./task"
import {
	createTempDir,
	cleanupTempDir,
	initGitRepo,
	initAgency,
	readFile,
	runTestEffect,
} from "../test-utils"

describe("save command", () => {
	let tempDir: string
	let originalCwd: string
	let originalConfigDir: string | undefined

	beforeEach(async () => {
		tempDir = await createTempDir()
		originalCwd = process.cwd()
		originalConfigDir = process.env.AGENCY_CONFIG_DIR
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
		if (
			process.env.AGENCY_CONFIG_DIR &&
			process.env.AGENCY_CONFIG_DIR !== originalConfigDir
		) {
			await cleanupTempDir(process.env.AGENCY_CONFIG_DIR)
		}
		await cleanupTempDir(tempDir)
	})

	test("saves specified files to template directory", async () => {
		await initGitRepo(tempDir)
		process.chdir(tempDir)

		// Initialize with template
		await initAgency(tempDir, "test-save")
		await task({ silent: true, emit: "test-feature" })

		// Modify the files
		await Bun.write(join(tempDir, "AGENTS.md"), "# Modified content")

		// Save specific files to template
		await runTestEffect(save({ files: ["AGENTS.md"], silent: true }))

		// Check template files were updated
		const configDir = process.env.AGENCY_CONFIG_DIR!
		const templateAgents = await readFile(
			join(configDir, "templates", "test-save", "AGENTS.md"),
		)

		expect(templateAgents).toBe("# Modified content")
	})

	test("throws error when no files specified", async () => {
		await initGitRepo(tempDir)
		process.chdir(tempDir)

		// Initialize with template
		await initAgency(tempDir, "test-no-files")
		await task({
			silent: true,
			emit: "test-feature",
		})

		await expect(
			runTestEffect(save({ files: [], silent: true })),
		).rejects.toThrow("No files specified")
	})

	test("throws error when no template configured", async () => {
		await initGitRepo(tempDir)
		process.chdir(tempDir)

		await expect(
			runTestEffect(save({ files: ["AGENTS.md"], silent: true })),
		).rejects.toThrow("Repository not initialized")
	})

	test("throws error when not in git repo", async () => {
		process.chdir(tempDir)

		await expect(
			runTestEffect(save({ files: ["AGENTS.md"], silent: true })),
		).rejects.toThrow("Not in a git repository")
	})

	test("skips files that don't exist", async () => {
		await initGitRepo(tempDir)
		process.chdir(tempDir)

		// Initialize with template
		await initAgency(tempDir, "test-partial")
		await task({
			silent: true,
			emit: "test-feature",
		})

		// Remove AGENTS.md (just to test skipping behavior)
		const rmProc = Bun.spawn(["rm", join(tempDir, "AGENTS.md")], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		})
		await rmProc.exited

		// Modify a different file that exists
		await Bun.write(join(tempDir, "test.txt"), "# Test content")

		// Save should succeed but skip the missing file
		await runTestEffect(
			save({ files: ["AGENTS.md", "test.txt"], silent: true }),
		)

		// Check test.txt was updated
		const configDir = process.env.AGENCY_CONFIG_DIR!
		const testContent = await readFile(
			join(configDir, "templates", "test-partial", "test.txt"),
		)
		expect(testContent).toBe("# Test content")
	})

	test("saves directories recursively", async () => {
		await initGitRepo(tempDir)
		process.chdir(tempDir)

		// Initialize with template
		await initAgency(tempDir, "test-dir")
		await task({ silent: true, emit: "test-feature" })

		// Create a directory with files
		const docsDir = join(tempDir, "docs")
		await Bun.write(join(docsDir, "README.md"), "# Documentation")
		await Bun.write(join(docsDir, "guide.md"), "# Guide")

		// Save the directory
		await runTestEffect(save({ files: ["docs"], silent: true }))

		// Check files were saved to template
		const configDir = process.env.AGENCY_CONFIG_DIR!
		const readmeContent = await readFile(
			join(configDir, "templates", "test-dir", "docs", "README.md"),
		)
		const guideContent = await readFile(
			join(configDir, "templates", "test-dir", "docs", "guide.md"),
		)

		expect(readmeContent).toBe("# Documentation")
		expect(guideContent).toBe("# Guide")
	})

	test("refuses to save TASK.md", async () => {
		await initGitRepo(tempDir)
		process.chdir(tempDir)

		// Initialize with template
		await initAgency(tempDir, "test-task")
		await task({ silent: true, emit: "test-feature" })

		// Create a TASK.md with the {task} placeholder
		await Bun.write(join(tempDir, "TASK.md"), "{task}\n\n## Notes")

		// Save should fail regardless of content
		await expect(
			runTestEffect(save({ files: ["TASK.md"], silent: true })),
		).rejects.toThrow("TASK.md files cannot be saved to templates")
	})

	test("refuses to save TASK.md even without {task} placeholder", async () => {
		await initGitRepo(tempDir)
		process.chdir(tempDir)

		// Initialize with template
		await initAgency(tempDir, "test-task-invalid")
		await task({
			silent: true,
			emit: "test-feature",
		})

		// Create a TASK.md without the {task} placeholder
		await Bun.write(
			join(tempDir, "TASK.md"),
			"# Specific Task\n\nThis is a specific task, not a template",
		)

		// Save should fail
		await expect(
			runTestEffect(save({ files: ["TASK.md"], silent: true })),
		).rejects.toThrow("TASK.md files cannot be saved to templates")
	})

	test("refuses to save TASK.md in subdirectories", async () => {
		await initGitRepo(tempDir)
		process.chdir(tempDir)

		// Initialize with template
		await initAgency(tempDir, "test-task-subdir")
		await task({
			silent: true,
			emit: "test-feature",
		})

		// Create a TASK.md in a subdirectory with the {task} placeholder
		const subdir = join(tempDir, "projects")
		await Bun.write(join(subdir, "TASK.md"), "{task}\n\n## Details")

		// Save should fail regardless of content
		await expect(
			runTestEffect(save({ files: ["projects/TASK.md"], silent: true })),
		).rejects.toThrow("TASK.md files cannot be saved to templates")
	})

	test("refuses to save TASK.md in subdirectory even without {task} placeholder", async () => {
		await initGitRepo(tempDir)
		process.chdir(tempDir)

		// Initialize with template
		await initAgency(tempDir, "test-task-subdir-invalid")
		await task({
			silent: true,
			emit: "test-feature",
		})

		// Create a TASK.md in a subdirectory without the {task} placeholder
		const subdir = join(tempDir, "projects")
		await Bun.write(
			join(subdir, "TASK.md"),
			"# Specific Project Task\n\nThis is specific",
		)

		// Save should fail
		await expect(
			runTestEffect(save({ files: ["projects/TASK.md"], silent: true })),
		).rejects.toThrow("TASK.md files cannot be saved to templates")
	})
})
