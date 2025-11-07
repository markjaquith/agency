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

	test("saves files to template directory", async () => {
		await initGitRepo(tempDir)
		process.chdir(tempDir)

		// Initialize with template
		await init({ silent: true, template: "test-save" })

		// Modify the files
		await Bun.write(join(tempDir, "AGENTS.md"), "# Modified content")
		await Bun.write(join(tempDir, "CLAUDE.md"), "# Modified CLAUDE")

		// Save to template
		await save({ silent: true })

		// Check template files were updated
		const configDir = process.env.AGENCY_CONFIG_DIR!
		const templateAgents = await readFile(
			join(configDir, "templates", "test-save", "AGENTS.md"),
		)
		const templateClaude = await readFile(
			join(configDir, "templates", "test-save", "CLAUDE.md"),
		)

		expect(templateAgents).toBe("# Modified content")
		expect(templateClaude).toBe("# Modified CLAUDE")
	})

	test("throws error when no template configured", async () => {
		await initGitRepo(tempDir)
		process.chdir(tempDir)

		await expect(save({ silent: true })).rejects.toThrow(
			"No template configured",
		)
	})

	test("throws error when not in git repo", async () => {
		process.chdir(tempDir)

		await expect(save({ silent: true })).rejects.toThrow(
			"Not in a git repository",
		)
	})

	test("skips files that don't exist", async () => {
		await initGitRepo(tempDir)
		process.chdir(tempDir)

		// Initialize with template
		await init({ silent: true, template: "test-partial" })

		// Remove CLAUDE.md
		const rmProc = Bun.spawn(["rm", join(tempDir, "CLAUDE.md")], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		})
		await rmProc.exited

		// Modify AGENTS.md
		await Bun.write(join(tempDir, "AGENTS.md"), "# Only agents")

		// Save should succeed
		await save({ silent: true })

		// Check only AGENTS.md was updated
		const configDir = process.env.AGENCY_CONFIG_DIR!
		const templateAgents = await readFile(
			join(configDir, "templates", "test-partial", "AGENTS.md"),
		)
		expect(templateAgents).toBe("# Only agents")

		// CLAUDE.md should still be default
		const templateClaude = await readFile(
			join(configDir, "templates", "test-partial", "CLAUDE.md"),
		)
		expect(templateClaude).toBe("@AGENTS.md")
	})
})
