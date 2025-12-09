import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { join } from "path"
import { task } from "../commands/task"
import {
	createTempDir,
	cleanupTempDir,
	initGitRepo,
	initAgency,
	createSubdir,
	fileExists,
	readFile,
	runTestEffect,
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

			await initAgency(tempDir, "test")

			await runTestEffect(task({ silent: true, branch: "test-feature" }))

			expect(await fileExists(join(tempDir, "AGENTS.md"))).toBe(true)
		})

		test("creates AGENTS.md with default content", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			await initAgency(tempDir, "test")

			await runTestEffect(task({ silent: true, branch: "test-feature" }))

			const content = await readFile(join(tempDir, "AGENTS.md"))
			expect(content).toContain("Repo Instructions")
			expect(content).toContain("AGENCY.md")
		})

		test("creates file at git root even when run from subdirectory", async () => {
			await initGitRepo(tempDir)
			const subdir = await createSubdir(tempDir, "subdir")
			process.chdir(subdir)

			await initAgency(tempDir, "test")

			await runTestEffect(task({ silent: true, branch: "test-feature" }))

			expect(await fileExists(join(tempDir, "AGENTS.md"))).toBe(true)
			expect(await fileExists(join(subdir, "AGENTS.md"))).toBe(false)
		})

		test("does not overwrite existing AGENTS.md", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			const existingContent = "# Existing content"
			await Bun.write(join(tempDir, "AGENTS.md"), existingContent)

			await initAgency(tempDir, "test")

			await runTestEffect(task({ silent: true, branch: "test-feature" }))

			const content = await readFile(join(tempDir, "AGENTS.md"))
			expect(content).toBe(existingContent)
		})

		test("throws error when not in a git repository", async () => {
			process.chdir(tempDir)

			await expect(runTestEffect(task({ silent: true }))).rejects.toThrow(
				"Not in a git repository",
			)
		})
	})

	describe("with path argument", () => {
		test("creates file at specified git root", async () => {
			await initGitRepo(tempDir)

			await initAgency(tempDir, "test")
			await runTestEffect(
				task({
					path: tempDir,
					silent: true,
					branch: "test-feature",
				}),
			)

			expect(await fileExists(join(tempDir, "AGENTS.md"))).toBe(true)
		})

		test("throws error when path is not a git repository root", async () => {
			await initGitRepo(tempDir)
			const subdir = await createSubdir(tempDir, "subdir")

			expect(
				runTestEffect(task({ path: subdir, silent: true })),
			).rejects.toThrow("not the root of a git repository")
		})

		test("throws error when path is not a git repository at all", async () => {
			expect(
				runTestEffect(task({ path: tempDir, silent: true })),
			).rejects.toThrow("not the root of a git repository")
		})

		test("resolves relative paths correctly", async () => {
			await initGitRepo(tempDir)
			const subdir = await createSubdir(tempDir, "subdir")
			process.chdir(subdir)

			await initAgency(tempDir, "test")
			await runTestEffect(
				task({
					path: "..",
					silent: true,
					branch: "test-feature",
				}),
			)

			expect(await fileExists(join(tempDir, "AGENTS.md"))).toBe(true)
		})
	})

	describe("opencode.json support", () => {
		test("creates opencode.json at git root", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			await initAgency(tempDir, "test")

			await runTestEffect(task({ silent: true, branch: "test-feature" }))

			expect(await fileExists(join(tempDir, "opencode.json"))).toBe(true)
		})

		test("creates opencode.json with default content", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			await initAgency(tempDir, "test")

			await runTestEffect(task({ silent: true, branch: "test-feature" }))

			const content = await readFile(join(tempDir, "opencode.json"))
			const parsed = JSON.parse(content)

			expect(parsed.$schema).toBe("https://opencode.ai/config.json")
			expect(parsed.instructions).toEqual(["AGENCY.md", "TASK.md"])
		})

		test("merges with existing opencode.json", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			const existingConfig = {
				custom: "config",
			}
			await Bun.write(
				join(tempDir, "opencode.json"),
				JSON.stringify(existingConfig),
			)

			await initAgency(tempDir, "test")

			await runTestEffect(task({ silent: true, branch: "test-feature" }))

			const content = await readFile(join(tempDir, "opencode.json"))
			const parsed = JSON.parse(content)

			// Should preserve existing properties
			expect(parsed.custom).toBe("config")

			// Should add our instructions
			expect(parsed.instructions).toContain("AGENCY.md")
			expect(parsed.instructions).toContain("TASK.md")
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

			await initAgency(tempDir, "custom-template")

			await runTestEffect(
				task({
					silent: true,
					branch: "test-feature",
				}),
			)

			const content = await readFile(join(tempDir, "opencode.json"))
			expect(content).toBe(customConfig)
		})

		test("merges with existing opencode.jsonc", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			const existingConfig = {
				custom: "config",
				existing: "property",
			}
			await Bun.write(
				join(tempDir, "opencode.jsonc"),
				JSON.stringify(existingConfig, null, 2),
			)

			await initAgency(tempDir, "test")

			await runTestEffect(task({ silent: true, branch: "test-feature" }))

			// Should update opencode.jsonc, not create opencode.json
			expect(await fileExists(join(tempDir, "opencode.jsonc"))).toBe(true)
			expect(await fileExists(join(tempDir, "opencode.json"))).toBe(false)

			const content = await readFile(join(tempDir, "opencode.jsonc"))
			const parsed = JSON.parse(content)

			// Should preserve existing properties
			expect(parsed.custom).toBe("config")
			expect(parsed.existing).toBe("property")

			// Should add our instructions
			expect(parsed.instructions).toContain("AGENCY.md")
			expect(parsed.instructions).toContain("TASK.md")
		})

		test("prefers opencode.jsonc over opencode.json when both exist", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			// Create both files
			const jsoncConfig = {
				custom: "jsonc-config",
			}
			const jsonConfig = {
				custom: "json-config",
			}
			await Bun.write(
				join(tempDir, "opencode.jsonc"),
				JSON.stringify(jsoncConfig, null, 2),
			)
			await Bun.write(
				join(tempDir, "opencode.json"),
				JSON.stringify(jsonConfig, null, 2),
			)

			await initAgency(tempDir, "test")

			await runTestEffect(task({ silent: true, branch: "test-feature" }))

			// Should merge with opencode.jsonc (not opencode.json)
			const jsoncContent = await readFile(join(tempDir, "opencode.jsonc"))
			const jsoncParsed = JSON.parse(jsoncContent)

			expect(jsoncParsed.custom).toBe("jsonc-config")
			expect(jsoncParsed.instructions).toContain("AGENCY.md")

			// opencode.json should remain unchanged
			const jsonContent = await readFile(join(tempDir, "opencode.json"))
			expect(jsonContent).toBe(JSON.stringify(jsonConfig, null, 2))
		})

		test("handles opencode.jsonc with comments", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			const jsoncWithComments = `{
	// This is a comment
	"custom": "config",
	/* Multi-line
	   comment */
	"existing": "property"
}`
			await Bun.write(join(tempDir, "opencode.jsonc"), jsoncWithComments)

			await initAgency(tempDir, "test")

			await runTestEffect(task({ silent: true, branch: "test-feature" }))

			const content = await readFile(join(tempDir, "opencode.jsonc"))
			const parsed = JSON.parse(content)

			// Should preserve existing properties
			expect(parsed.custom).toBe("config")
			expect(parsed.existing).toBe("property")

			// Should add our instructions
			expect(parsed.instructions).toContain("AGENCY.md")
			expect(parsed.instructions).toContain("TASK.md")
		})

		test("merges with .opencode/opencode.json", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			// Create .opencode directory with opencode.json
			const dotOpencodeDir = join(tempDir, ".opencode")
			await Bun.spawn(["mkdir", "-p", dotOpencodeDir], {
				stdout: "pipe",
				stderr: "pipe",
			}).exited

			const existingConfig = {
				custom: "config-in-dotdir",
			}
			await Bun.write(
				join(dotOpencodeDir, "opencode.json"),
				JSON.stringify(existingConfig, null, 2),
			)

			await initAgency(tempDir, "test")

			await runTestEffect(task({ silent: true, branch: "test-feature" }))

			// Should update .opencode/opencode.json, not create root opencode.json
			expect(await fileExists(join(dotOpencodeDir, "opencode.json"))).toBe(true)
			expect(await fileExists(join(tempDir, "opencode.json"))).toBe(false)

			const content = await readFile(join(dotOpencodeDir, "opencode.json"))
			const parsed = JSON.parse(content)

			// Should preserve existing properties
			expect(parsed.custom).toBe("config-in-dotdir")

			// Should add our instructions
			expect(parsed.instructions).toContain("AGENCY.md")
			expect(parsed.instructions).toContain("TASK.md")
		})

		test("merges with .opencode/opencode.jsonc", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			// Create .opencode directory with opencode.jsonc
			const dotOpencodeDir = join(tempDir, ".opencode")
			await Bun.spawn(["mkdir", "-p", dotOpencodeDir], {
				stdout: "pipe",
				stderr: "pipe",
			}).exited

			const existingConfig = {
				custom: "jsonc-in-dotdir",
			}
			await Bun.write(
				join(dotOpencodeDir, "opencode.jsonc"),
				JSON.stringify(existingConfig, null, 2),
			)

			await initAgency(tempDir, "test")

			await runTestEffect(task({ silent: true, branch: "test-feature" }))

			// Should update .opencode/opencode.jsonc, not create root opencode.json
			expect(await fileExists(join(dotOpencodeDir, "opencode.jsonc"))).toBe(
				true,
			)
			expect(await fileExists(join(tempDir, "opencode.json"))).toBe(false)

			const content = await readFile(join(dotOpencodeDir, "opencode.jsonc"))
			const parsed = JSON.parse(content)

			// Should preserve existing properties
			expect(parsed.custom).toBe("jsonc-in-dotdir")

			// Should add our instructions
			expect(parsed.instructions).toContain("AGENCY.md")
			expect(parsed.instructions).toContain("TASK.md")
		})

		test("prefers .opencode/opencode.jsonc over root opencode.json", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			// Create .opencode directory with opencode.jsonc
			const dotOpencodeDir = join(tempDir, ".opencode")
			await Bun.spawn(["mkdir", "-p", dotOpencodeDir], {
				stdout: "pipe",
				stderr: "pipe",
			}).exited

			const dotOpencodeConfig = {
				custom: "dotdir-jsonc",
			}
			const rootJsonConfig = {
				custom: "root-json",
			}

			await Bun.write(
				join(dotOpencodeDir, "opencode.jsonc"),
				JSON.stringify(dotOpencodeConfig, null, 2),
			)
			await Bun.write(
				join(tempDir, "opencode.json"),
				JSON.stringify(rootJsonConfig, null, 2),
			)

			await initAgency(tempDir, "test")

			await runTestEffect(task({ silent: true, branch: "test-feature" }))

			// Should merge with .opencode/opencode.jsonc (not root opencode.json)
			const dotDirContent = await readFile(
				join(dotOpencodeDir, "opencode.jsonc"),
			)
			const dotDirParsed = JSON.parse(dotDirContent)

			expect(dotDirParsed.custom).toBe("dotdir-jsonc")
			expect(dotDirParsed.instructions).toContain("AGENCY.md")

			// root opencode.json should remain unchanged
			const rootContent = await readFile(join(tempDir, "opencode.json"))
			expect(rootContent).toBe(JSON.stringify(rootJsonConfig, null, 2))
		})

		test("prefers .opencode/opencode.json over root opencode.jsonc", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			// Create .opencode directory with opencode.json
			const dotOpencodeDir = join(tempDir, ".opencode")
			await Bun.spawn(["mkdir", "-p", dotOpencodeDir], {
				stdout: "pipe",
				stderr: "pipe",
			}).exited

			const dotOpencodeConfig = {
				custom: "dotdir-json",
			}
			const rootJsoncConfig = {
				custom: "root-jsonc",
			}

			await Bun.write(
				join(dotOpencodeDir, "opencode.json"),
				JSON.stringify(dotOpencodeConfig, null, 2),
			)
			await Bun.write(
				join(tempDir, "opencode.jsonc"),
				JSON.stringify(rootJsoncConfig, null, 2),
			)

			await initAgency(tempDir, "test")

			await runTestEffect(task({ silent: true, branch: "test-feature" }))

			// Should merge with .opencode/opencode.json (not root opencode.jsonc)
			const dotDirContent = await readFile(
				join(dotOpencodeDir, "opencode.json"),
			)
			const dotDirParsed = JSON.parse(dotDirContent)

			expect(dotDirParsed.custom).toBe("dotdir-json")
			expect(dotDirParsed.instructions).toContain("AGENCY.md")

			// root opencode.jsonc should remain unchanged
			const rootContent = await readFile(join(tempDir, "opencode.jsonc"))
			expect(rootContent).toBe(JSON.stringify(rootJsoncConfig, null, 2))
		})

		test("adds .opencode/opencode.json to injectedFiles", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			// Create .opencode directory with opencode.json
			const dotOpencodeDir = join(tempDir, ".opencode")
			await Bun.spawn(["mkdir", "-p", dotOpencodeDir], {
				stdout: "pipe",
				stderr: "pipe",
			}).exited

			await Bun.write(
				join(dotOpencodeDir, "opencode.json"),
				JSON.stringify({ custom: "config" }, null, 2),
			)

			await initAgency(tempDir, "test")

			await runTestEffect(task({ silent: true, branch: "test-feature" }))

			// Check agency.json to verify .opencode/opencode.json is in injectedFiles
			const agencyJsonContent = await readFile(join(tempDir, "agency.json"))
			const metadata = JSON.parse(agencyJsonContent)

			expect(metadata.injectedFiles).toContain(".opencode/opencode.json")
		})
	})

	describe("TASK.md support", () => {
		test("creates TASK.md at git root", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			await initAgency(tempDir, "test")

			await runTestEffect(task({ silent: true, branch: "test-feature" }))

			expect(await fileExists(join(tempDir, "TASK.md"))).toBe(true)
		})

		test("creates TASK.md with placeholder when no task provided", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			await initAgency(tempDir, "test")

			await runTestEffect(task({ silent: true, branch: "test-feature" }))

			const content = await readFile(join(tempDir, "TASK.md"))
			expect(content).toContain("{task}")
		})

		test("creates TASK.md with task description when provided", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			await initAgency(tempDir, "test")
			await runTestEffect(
				task({
					silent: true,
					task: "Build new feature",
					branch: "test-feature",
				}),
			)

			const content = await readFile(join(tempDir, "TASK.md"))
			expect(content).toContain("Build new feature")
			expect(content).not.toContain("{task}")
		})

		test("skips TASK.md if it already exists", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			const existingContent = "# Existing TASK"
			await Bun.write(join(tempDir, "TASK.md"), existingContent)

			await initAgency(tempDir, "test")

			// Should succeed but skip TASK.md
			await runTestEffect(task({ silent: true, branch: "test-feature" }))

			// TASK.md should not be overwritten
			const content = await readFile(join(tempDir, "TASK.md"))
			expect(content).toBe(existingContent)

			// Other files should still be created
			expect(await fileExists(join(tempDir, "AGENTS.md"))).toBe(true)
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

			await initAgency(tempDir, "custom-template")

			await runTestEffect(
				task({
					silent: true,
					branch: "test-feature",
				}),
			)

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

			await initAgency(tempDir, "test")

			await runTestEffect(task({ silent: true, branch: "test-feature" }))

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
			await initAgency(tempDir, "test")
			await runTestEffect(
				task({
					silent: false,
					task: "Test task",
					branch: "test-feature",
				}),
			)

			console.log = originalLog

			expect(logs.length).toBeGreaterThan(0)
			expect(logs.some((log) => log.includes("Created"))).toBe(true)
		})
	})

	describe("branch handling", () => {
		test("fails when on main branch without branch name", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			await initAgency(tempDir, "test")
			await expect(runTestEffect(task({ silent: true }))).rejects.toThrow(
				"main branch",
			)
		})

		test("creates branch when on main branch with branch name provided", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			await initAgency(tempDir, "test")

			await runTestEffect(task({ silent: true, branch: "my-feature" }))

			// Verify we're now on the new branch
			const proc = Bun.spawn(["git", "branch", "--show-current"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			})
			await proc.exited
			const currentBranch = await new Response(proc.stdout).text()
			expect(currentBranch.trim()).toBe("agency/my-feature")

			// Verify files were created
			expect(await fileExists(join(tempDir, "AGENTS.md"))).toBe(true)
		})

		test("fails early when branch already exists", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			// Create a feature branch first (using source pattern)
			await Bun.spawn(["git", "checkout", "-b", "agency/existing-branch"], {
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
				(async () => {
					await initAgency(tempDir, "test")
					return await runTestEffect(
						task({
							silent: true,
							branch: "existing-branch",
							task: "This should not be asked for",
						}),
					)
				})(),
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
			await initAgency(tempDir, "test")

			await runTestEffect(task({ silent: true, branch: "test-feature" }))

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

			await initAgency(tempDir, "custom")

			await runTestEffect(task({ silent: true, branch: "test-feature" }))

			const content = await readFile(join(tempDir, "AGENTS.md"))
			expect(content).toBe(sourceContent)
		})

		test("uses default content when template doesn't exist yet", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			await initAgency(tempDir, "custom-template")

			await runTestEffect(
				task({
					silent: true,
					branch: "test-feature",
				}),
			)

			const agentsContent = await readFile(join(tempDir, "AGENTS.md"))

			expect(agentsContent).toContain("Repo Instructions")
		})

		test("does not populate template directory automatically on first use", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			await initAgency(tempDir, "auto-created")

			await runTestEffect(
				task({
					silent: true,
					branch: "test-feature",
				}),
			)

			// Template should NOT have AGENTS.md (not populated automatically)
			const templateDir = join(configDir, "templates", "auto-created")
			const templateAgentsExists = await fileExists(
				join(templateDir, "AGENTS.md"),
			)
			expect(templateAgentsExists).toBe(false)

			// Files in repo should use default content (not from template)
			const agentsContent = await readFile(join(tempDir, "AGENTS.md"))
			expect(agentsContent).toContain("Repo Instructions")
		})

		test("excludes AGENCY.md and TASK.md from injectedFiles metadata", async () => {
			await initGitRepo(tempDir)
			process.chdir(tempDir)

			await initAgency(tempDir, "test")

			await runTestEffect(
				task({
					silent: true,
					branch: "test-feature",
				}),
			)

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
