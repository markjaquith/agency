import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { init } from "./init"
import {
	createTempDir,
	cleanupTempDir,
	initGitRepo,
	getGitConfig,
	runTestEffect,
} from "../test-utils"

describe("init command", () => {
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

	describe("basic initialization", () => {
		test("initializes with template flag", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			await runTestEffect(init({ template: "test-template", silent: true }))

			const configValue = await getGitConfig("agency.template", tempDir)
			expect(configValue).toBe("test-template")
		})

		test("saves template name to git config", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			await runTestEffect(init({ template: "my-template", silent: true }))

			const configValue = await getGitConfig("agency.template", tempDir)
			expect(configValue).toBe("my-template")
		})

		test("accepts template names with hyphens", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			await runTestEffect(init({ template: "my-work-template", silent: true }))

			const configValue = await getGitConfig("agency.template", tempDir)
			expect(configValue).toBe("my-work-template")
		})

		test("accepts template names with underscores", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			await runTestEffect(init({ template: "my_work_template", silent: true }))

			const configValue = await getGitConfig("agency.template", tempDir)
			expect(configValue).toBe("my_work_template")
		})
	})

	describe("error handling", () => {
		test("throws error when not in git repository", async () => {
			process.chdir(tempDir)

			await expect(
				runTestEffect(init({ template: "test", silent: true })),
			).rejects.toThrow("Not in a git repository")
		})

		test("throws error when already initialized without template flag", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			// Initialize first time
			await runTestEffect(init({ template: "first-template", silent: true }))

			// Try to initialize again without template flag
			await expect(runTestEffect(init({ silent: true }))).rejects.toThrow(
				"Already initialized",
			)
		})

		test("allows re-initialization with different template", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			// Initialize first time
			await runTestEffect(init({ template: "first-template", silent: true }))

			// Re-initialize with different template
			await runTestEffect(init({ template: "second-template", silent: true }))

			const configValue = await getGitConfig("agency.template", tempDir)
			expect(configValue).toBe("second-template")
		})

		test("requires template name in silent mode", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			await expect(runTestEffect(init({ silent: true }))).rejects.toThrow(
				"Template name required",
			)
		})
	})

	describe("template directory", () => {
		test("does not create template directory during init", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			await runTestEffect(init({ template: "test-template", silent: true }))

			const configDir = process.env.AGENCY_CONFIG_DIR!
			const templateDir = Bun.file(
				`${configDir}/templates/test-template/AGENTS.md`,
			)
			const exists = await templateDir.exists()
			expect(exists).toBe(false)
		})

		test("sets config even if template directory doesn't exist", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			await runTestEffect(init({ template: "nonexistent", silent: true }))

			const configValue = await getGitConfig("agency.template", tempDir)
			expect(configValue).toBe("nonexistent")
		})
	})

	describe("silent mode", () => {
		test("works without output in silent mode", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			// Should not throw and should complete successfully
			await runTestEffect(init({ template: "silent-test", silent: true }))

			const configValue = await getGitConfig("agency.template", tempDir)
			expect(configValue).toBe("silent-test")
		})

		test("fails in silent mode without template", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			await expect(runTestEffect(init({ silent: true }))).rejects.toThrow(
				"Template name required",
			)
		})
	})

	describe("verbose mode", () => {
		test("works in verbose mode", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			// Capture output to prevent test noise
			const originalLog = console.log
			console.log = () => {}

			try {
				// Should complete successfully even with verbose logging
				await runTestEffect(
					init({ template: "verbose-test", verbose: true, silent: false }),
				)

				const configValue = await getGitConfig("agency.template", tempDir)
				expect(configValue).toBe("verbose-test")
			} finally {
				console.log = originalLog
			}
		})
	})

	describe("edge cases", () => {
		test("handles empty template name", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			await expect(
				runTestEffect(init({ template: "", silent: true })),
			).rejects.toThrow("Template name required")
		})

		test("handles template name with special characters", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			// Template names with dots or slashes might cause issues
			await runTestEffect(init({ template: "test.template", silent: true }))

			const configValue = await getGitConfig("agency.template", tempDir)
			expect(configValue).toBe("test.template")
		})

		test("handles very long template names", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			const longName = "a".repeat(100)
			await runTestEffect(init({ template: longName, silent: true }))

			const configValue = await getGitConfig("agency.template", tempDir)
			expect(configValue).toBe(longName)
		})
	})

	describe("multiple initializations", () => {
		test("changing template updates git config", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			await runTestEffect(init({ template: "template-a", silent: true }))
			let configValue = await getGitConfig("agency.template", tempDir)
			expect(configValue).toBe("template-a")

			await runTestEffect(init({ template: "template-b", silent: true }))
			configValue = await getGitConfig("agency.template", tempDir)
			expect(configValue).toBe("template-b")
		})

		test("preserves template name across command runs", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			await runTestEffect(init({ template: "persistent", silent: true }))

			// Check multiple times to ensure it persists
			const value1 = await getGitConfig("agency.template", tempDir)
			const value2 = await getGitConfig("agency.template", tempDir)

			expect(value1).toBe("persistent")
			expect(value2).toBe("persistent")
		})
	})
})
