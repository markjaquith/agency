import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { join } from "path"
import { task } from "../commands/task"
import {
	createTempDir,
	cleanupTempDir,
	initGitRepo,
	createSubdir,
	fileExists,
	readFile,
} from "../test-utils"

describe("task command", () => {
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

			await task({ silent: true, template: "test", branch: "test-feature" })

			expect(await fileExists(join(tempDir, "AGENTS.md"))).toBe(true)
		})

		test("creates AGENTS.md with default content", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			await task({ silent: true, template: "test", branch: "test-feature" })

			const content = await readFile(join(tempDir, "AGENTS.md"))
			expect(content).toContain("Repo Instructions")
			expect(content).toContain("AGENCY.md")
		})

		test("creates file at git root even when run from subdirectory", async () => {
			await initGitRepo(tempDir)
			const subdir = await createSubdir(tempDir, "subdir")
			process.chdir(subdir)

			await task({ silent: true, template: "test", branch: "test-feature" })

			expect(await fileExists(join(tempDir, "AGENTS.md"))).toBe(true)
			expect(await fileExists(join(subdir, "AGENTS.md"))).toBe(false)
		})

		test("does not overwrite existing AGENTS.md", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			const existingContent = "# Existing content"
			await Bun.write(join(tempDir, "AGENTS.md"), existingContent)

			await task({ silent: true, template: "test", branch: "test-feature" })

			const content = await readFile(join(tempDir, "AGENTS.md"))
			expect(content).toBe(existingContent)
		})

		test("throws error when not in a git repository", async () => {
			process.chdir(tempDir)

			await expect(task({ silent: true })).rejects.toThrow(
				"Not in a git repository",
			)
		})
	})

	describe("with path argument", () => {
		test("creates file at specified git root", async () => {
			await initGitRepo(tempDir)

			await task({
				path: tempDir,
				silent: true,
				template: "test",
				branch: "test-feature",
			})

			expect(await fileExists(join(tempDir, "AGENTS.md"))).toBe(true)
		})

		test("throws error when path is not a git repository root", async () => {
			await initGitRepo(tempDir)
			const subdir = await createSubdir(tempDir, "subdir")

			expect(task({ path: subdir, silent: true })).rejects.toThrow(
				"not the root of a git repository",
			)
		})

		test("throws error when path is not a git repository at all", async () => {
			expect(task({ path: tempDir, silent: true })).rejects.toThrow(
				"not the root of a git repository",
			)
		})

		test("resolves relative paths correctly", async () => {
			await initGitRepo(tempDir)
			const subdir = await createSubdir(tempDir, "subdir")
			process.chdir(subdir)

			await task({
				path: "..",
				silent: true,
				template: "test",
				branch: "test-feature",
			})

			expect(await fileExists(join(tempDir, "AGENTS.md"))).toBe(true)
		})
	})

	describe("opencode.json support", () => {
		test("creates opencode.json at git root", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			await task({ silent: true, template: "test", branch: "test-feature" })

			expect(await fileExists(join(tempDir, "opencode.json"))).toBe(true)
		})

		test("creates opencode.json with default content", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			await task({ silent: true, template: "test", branch: "test-feature" })

			const content = await readFile(join(tempDir, "opencode.json"))
			const parsed = JSON.parse(content)

			expect(parsed.$schema).toBe("https://opencode.ai/config.json")
			expect(parsed.instructions).toEqual(["AGENCY.md", "TASK.md"])
		})

		test("does not overwrite existing opencode.json", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			const existingContent = JSON.stringify({
				custom: "config",
			})
			await Bun.write(join(tempDir, "opencode.json"), existingContent)

			await task({ silent: true, template: "test", branch: "test-feature" })

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

			await task({
				silent: true,
				template: "custom-template",
				branch: "test-feature",
			})

			const content = await readFile(join(tempDir, "opencode.json"))
			expect(content).toBe(customConfig)
		})
	})

	describe("TASK.md support", () => {
		test("creates TASK.md at git root", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			await task({ silent: true, template: "test", branch: "test-feature" })

			expect(await fileExists(join(tempDir, "TASK.md"))).toBe(true)
		})

		test("creates TASK.md with placeholder when no task provided", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			await task({ silent: true, template: "test", branch: "test-feature" })

			const content = await readFile(join(tempDir, "TASK.md"))
			expect(content).toContain("{task}")
		})

		test("creates TASK.md with task description when provided", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			await task({
				silent: true,
				template: "test",
				task: "Build new feature",
				branch: "test-feature",
			})

			const content = await readFile(join(tempDir, "TASK.md"))
			expect(content).toContain("Build new feature")
			expect(content).not.toContain("{task}")
		})

		test("aborts if TASK.md already exists", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			const existingContent = "# Existing TASK"
			await Bun.write(join(tempDir, "TASK.md"), existingContent)

			await expect(
				task({ silent: true, template: "test", branch: "test-feature" }),
			).rejects.toThrow("TASK.md already exists in the repository")
		})

		test("uses TASK.md from template directory if it exists", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			const configDir = process.env.AGENCY_CONFIG_DIR!
			const templateDir = join(configDir, "templates", "custom-template")
			await Bun.spawn(["mkdir", "-p", templateDir], {
				stdout: "pipe",
				stderr: "pipe",
			}).exited

			const customTask = "# Custom Task Content"
			await Bun.write(join(templateDir, "TASK.md"), customTask)

			await task({
				silent: true,
				template: "custom-template",
				branch: "test-feature",
			})

			const content = await readFile(join(tempDir, "TASK.md"))
			expect(content).toBe(customTask)
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

			await task({ silent: true, template: "test", branch: "test-feature" })

			console.log = originalLog

			expect(logs.length).toBe(0)
			expect(await fileExists(join(tempDir, "AGENTS.md"))).toBe(true)
		})

		test("without silent flag produces output", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			// Create a feature branch to avoid the main branch check
			await Bun.spawn(["git", "checkout", "-b", "test-feature"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited

			// Capture console.log calls
			const logs: string[] = []
			const originalLog = console.log
			console.log = (...args: any[]) => logs.push(args.join(" "))

			// Provide task to avoid interactive prompt
			await task({
				silent: false,
				template: "test",
				task: "Test task",
				branch: "test-feature",
			})

			console.log = originalLog

			expect(logs.length).toBeGreaterThan(0)
			expect(logs.some((log) => log.includes("Created"))).toBe(true)
		})
	})

	describe("branch handling", () => {
		test("fails when on main branch without branch name", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			await expect(task({ silent: true, template: "test" })).rejects.toThrow(
				"main branch",
			)
		})

		test("creates branch when on main branch with branch name provided", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			await task({ silent: true, template: "test", branch: "my-feature" })

			// Verify we're now on the new branch
			const proc = Bun.spawn(["git", "branch", "--show-current"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			})
			await proc.exited
			const currentBranch = await new Response(proc.stdout).text()
			expect(currentBranch.trim()).toBe("my-feature")

			// Verify files were created
			expect(await fileExists(join(tempDir, "AGENTS.md"))).toBe(true)
		})

		test("fails early when branch already exists", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			// Create a feature branch first
			await Bun.spawn(["git", "checkout", "-b", "existing-branch"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited

			// Switch back to main
			await Bun.spawn(["git", "checkout", "main"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited

			// Try to create a branch with the same name
			await expect(
				task({
					silent: true,
					template: "test",
					branch: "existing-branch",
					task: "This should not be asked for",
				}),
			).rejects.toThrow("already exists")
		})

		test("succeeds when already on a feature branch", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			// Create and switch to feature branch
			await Bun.spawn(["git", "checkout", "-b", "feature-branch"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited

			// Should succeed without needing branch option
			await task({ silent: true, template: "test", branch: "test-feature" })

			expect(await fileExists(join(tempDir, "AGENTS.md"))).toBe(true)
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

			await task({ silent: true, template: "custom", branch: "test-feature" })

			const content = await readFile(join(tempDir, "AGENTS.md"))
			expect(content).toBe(sourceContent)
		})

		test("uses default content when template doesn't exist yet", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			await task({
				silent: true,
				template: "custom-template",
				branch: "test-feature",
			})

			const agentsContent = await readFile(join(tempDir, "AGENTS.md"))

			expect(agentsContent).toContain("Repo Instructions")
		})

		test("creates template files automatically on first use", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			await task({
				silent: true,
				template: "auto-created",
				branch: "test-feature",
			})

			// Template should have been created
			const templateDir = join(configDir, "templates", "auto-created")
			const templateAgents = await readFile(join(templateDir, "AGENTS.md"))

			expect(templateAgents).toContain("Repo Instructions")

			// Files in repo should match template
			const agentsContent = await readFile(join(tempDir, "AGENTS.md"))

			expect(agentsContent).toContain("Repo Instructions")
		})

		test("excludes AGENCY.md and TASK.md from injectedFiles metadata", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			await task({
				silent: true,
				template: "test",
				branch: "test-feature",
			})

			// Read agency.json metadata
			const metadata = JSON.parse(await readFile(join(tempDir, "agency.json")))

			// AGENCY.md and TASK.md should NOT be in injectedFiles
			expect(metadata.injectedFiles).not.toContain("AGENCY.md")
			expect(metadata.injectedFiles).not.toContain("TASK.md")

			// opencode.json should be in injectedFiles
			expect(metadata.injectedFiles).toContain("opencode.json")
		})
	})
})
