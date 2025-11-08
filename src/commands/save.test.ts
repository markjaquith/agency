import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { join } from "path"
import { save } from "./save"
import { init } from "./init"
import {
	createTempDir,
	cleanupTempDir,
	initGitRepo,
	readFile,
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
		await init({ silent: true, template: "test-save" })

		// Modify the files
		await Bun.write(join(tempDir, "AGENTS.md"), "# Modified content")

		// Save specific files to template
		await save({ files: ["AGENTS.md"], silent: true })

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
		await init({ silent: true, template: "test-no-files" })

		await expect(save({ files: [], silent: true })).rejects.toThrow(
			"No files specified",
		)
	})

	test("throws error when no template configured", async () => {
		await initGitRepo(tempDir)
		process.chdir(tempDir)

		await expect(save({ files: ["AGENTS.md"], silent: true })).rejects.toThrow(
			"No template configured",
		)
	})

	test("throws error when not in git repo", async () => {
		process.chdir(tempDir)

		await expect(save({ files: ["AGENTS.md"], silent: true })).rejects.toThrow(
			"Not in a git repository",
		)
	})

	test("skips files that don't exist", async () => {
		await initGitRepo(tempDir)
		process.chdir(tempDir)

		// Initialize with template
		await init({ silent: true, template: "test-partial" })

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
		await save({ files: ["AGENTS.md", "test.txt"], silent: true })

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
		await init({ silent: true, template: "test-dir" })

		// Create a directory with files
		const docsDir = join(tempDir, "docs")
		await Bun.write(join(docsDir, "README.md"), "# Documentation")
		await Bun.write(join(docsDir, "guide.md"), "# Guide")

		// Save the directory
		await save({ files: ["docs"], silent: true })

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
})
