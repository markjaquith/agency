import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { join } from "path"
import { init } from "../commands/init"
import {
	createTempDir,
	cleanupTempDir,
	initGitRepo,
	createSubdir,
	fileExists,
	readFile,
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

	describe("without path argument", () => {
		test("creates AGENTS.md at git root", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			await init({ silent: true, template: "test" })

			expect(await fileExists(join(tempDir, "AGENTS.md"))).toBe(true)
		})

		test("creates AGENTS.md as blank file", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			await init({ silent: true, template: "test" })

			const content = await readFile(join(tempDir, "AGENTS.md"))
			expect(content).toBe("")
		})

		test("creates file at git root even when run from subdirectory", async () => {
			await initGitRepo(tempDir)
			const subdir = await createSubdir(tempDir, "subdir")
			process.chdir(subdir)

			await init({ silent: true, template: "test" })

			expect(await fileExists(join(tempDir, "AGENTS.md"))).toBe(true)
			expect(await fileExists(join(subdir, "AGENTS.md"))).toBe(false)
		})

		test("does not overwrite existing AGENTS.md", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			const existingContent = "# Existing content"
			await Bun.write(join(tempDir, "AGENTS.md"), existingContent)

			await init({ silent: true, template: "test" })

			const content = await readFile(join(tempDir, "AGENTS.md"))
			expect(content).toBe(existingContent)
		})

		test("throws error when not in a git repository", async () => {
			process.chdir(tempDir)

			await expect(init({ silent: true })).rejects.toThrow(
				"Not in a git repository",
			)
		})
	})

	describe("with path argument", () => {
		test("creates file at specified git root", async () => {
			await initGitRepo(tempDir)

			await init({ path: tempDir, silent: true, template: "test" })

			expect(await fileExists(join(tempDir, "AGENTS.md"))).toBe(true)
		})

		test("throws error when path is not a git repository root", async () => {
			await initGitRepo(tempDir)
			const subdir = await createSubdir(tempDir, "subdir")

			expect(init({ path: subdir, silent: true })).rejects.toThrow(
				"not the root of a git repository",
			)
		})

		test("throws error when path is not a git repository at all", async () => {
			expect(init({ path: tempDir, silent: true })).rejects.toThrow(
				"not the root of a git repository",
			)
		})

		test("resolves relative paths correctly", async () => {
			await initGitRepo(tempDir)
			const subdir = await createSubdir(tempDir, "subdir")
			process.chdir(subdir)

			await init({ path: "..", silent: true, template: "test" })

			expect(await fileExists(join(tempDir, "AGENTS.md"))).toBe(true)
		})
	})

	describe("opencode.json support", () => {
		test("creates opencode.json at git root", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			await init({ silent: true, template: "test" })

			expect(await fileExists(join(tempDir, "opencode.json"))).toBe(true)
		})

		test("creates opencode.json with default content", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			await init({ silent: true, template: "test" })

			const content = await readFile(join(tempDir, "opencode.json"))
			const parsed = JSON.parse(content)

			expect(parsed.$schema).toBe("https://opencode.ai/config.json")
			expect(parsed.instructions).toEqual(["TASK.md"])
		})

		test("does not overwrite existing opencode.json", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			const existingContent = JSON.stringify({
				custom: "config",
			})
			await Bun.write(join(tempDir, "opencode.json"), existingContent)

			await init({ silent: true, template: "test" })

			const content = await readFile(join(tempDir, "opencode.json"))
			expect(content).toBe(existingContent)
		})

		test("uses opencode.json from template directory if it exists", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			const configDir = process.env.AGENCY_CONFIG_DIR!
			const templateDir = join(configDir, "templates", "custom-template")
			await Bun.spawn(["mkdir", "-p", templateDir], {
				stdout: "pipe",
				stderr: "pipe",
			}).exited

			const customConfig = JSON.stringify({
				$schema: "https://opencode.ai/config.json",
				instructions: ["CUSTOM.md"],
			})
			await Bun.write(join(templateDir, "opencode.json"), customConfig)

			await init({ silent: true, template: "custom-template" })

			const content = await readFile(join(tempDir, "opencode.json"))
			expect(content).toBe(customConfig)
		})
	})

	describe("silent mode", () => {
		test("silent flag suppresses output", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			// Capture console.log calls
			const logs: string[] = []
			const originalLog = console.log
			console.log = (...args: any[]) => logs.push(args.join(" "))

			await init({ silent: true, template: "test" })

			console.log = originalLog

			expect(logs.length).toBe(0)
			expect(await fileExists(join(tempDir, "AGENTS.md"))).toBe(true)
		})

		test("without silent flag produces output", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			// Capture console.log calls
			const logs: string[] = []
			const originalLog = console.log
			console.log = (...args: any[]) => logs.push(args.join(" "))

			await init({ silent: false, template: "test" })

			console.log = originalLog

			expect(logs.length).toBeGreaterThan(0)
			expect(logs.some((log) => log.includes("Created"))).toBe(true)
		})
	})

	describe("template-based source files", () => {
		let configDir: string
		let originalEnv: string | undefined

		beforeEach(async () => {
			// Create a temporary config directory
			configDir = await createTempDir()
			originalEnv = process.env.AGENCY_CONFIG_DIR
			process.env.AGENCY_CONFIG_DIR = configDir
		})

		afterEach(async () => {
			// Restore original env
			if (originalEnv !== undefined) {
				process.env.AGENCY_CONFIG_DIR = originalEnv
			} else {
				delete process.env.AGENCY_CONFIG_DIR
			}
			await cleanupTempDir(configDir)
		})

		test("uses AGENTS.md from template directory if it exists", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			// Create template with custom content
			const templateDir = join(configDir, "templates", "custom")
			await Bun.spawn(["mkdir", "-p", templateDir], {
				stdout: "pipe",
				stderr: "pipe",
			}).exited

			const sourceContent = "# Custom AGENTS.md content\nThis is from template"
			await Bun.write(join(templateDir, "AGENTS.md"), sourceContent)

			await init({ silent: true, template: "custom" })

			const content = await readFile(join(tempDir, "AGENTS.md"))
			expect(content).toBe(sourceContent)
		})

		test("uses default content when template doesn't exist yet", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			await init({ silent: true, template: "new-template" })

			const agentsContent = await readFile(join(tempDir, "AGENTS.md"))

			expect(agentsContent).toBe("")
		})

		test("creates template files automatically on first use", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			await init({ silent: true, template: "auto-created" })

			// Template should have been created
			const templateDir = join(configDir, "templates", "auto-created")
			const templateAgents = await readFile(join(templateDir, "AGENTS.md"))

			expect(templateAgents).toBe("")

			// Files in repo should match template
			const agentsContent = await readFile(join(tempDir, "AGENTS.md"))

			expect(agentsContent).toBe("")
		})
	})
})
