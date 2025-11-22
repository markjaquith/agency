import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { templateList } from "./template-list"
import { mkdir, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

describe("template list command", () => {
	let testDir: string
	let gitRoot: string
	let templateDir: string

	beforeEach(async () => {
		// Create temporary test directory
		testDir = join(tmpdir(), `agency-test-list-${Date.now()}`)
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

	test("lists files in template directory", async () => {
		// Create test files in template
		await writeFile(join(templateDir, "AGENTS.md"), "# Agents")
		await writeFile(join(templateDir, "opencode.json"), "{}")
		await mkdir(join(templateDir, "docs"), { recursive: true })
		await writeFile(join(templateDir, "docs", "README.md"), "# Docs")

		// Capture output
		const output: string[] = []
		const originalLog = console.log
		console.log = (...args: any[]) => {
			output.push(args.join(" "))
		}

		const originalCwd = process.cwd()
		process.chdir(gitRoot)

		try {
			await templateList({ silent: false })
		} finally {
			process.chdir(originalCwd)
			console.log = originalLog
		}

		expect(output.length).toBeGreaterThan(0)
		expect(output.some((line) => line.includes("AGENTS.md"))).toBe(true)
		expect(output.some((line) => line.includes("opencode.json"))).toBe(true)
		expect(output.some((line) => line.includes("docs/README.md"))).toBe(true)
	})

	test("handles empty template directory", async () => {
		// Capture output
		const output: string[] = []
		const originalLog = console.log
		console.log = (...args: any[]) => {
			output.push(args.join(" "))
		}

		const originalCwd = process.cwd()
		process.chdir(gitRoot)

		try {
			await templateList({ silent: false })
		} finally {
			process.chdir(originalCwd)
			console.log = originalLog
		}

		expect(output.some((line) => line.includes("has no files"))).toBe(true)
	})

	test("throws error when not in git repository", async () => {
		const nonGitDir = join(testDir, "non-git")
		await mkdir(nonGitDir, { recursive: true })

		const originalCwd = process.cwd()
		process.chdir(nonGitDir)

		try {
			await expect(templateList({ silent: true })).rejects.toThrow(
				"Not in a git repository",
			)
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
			await expect(templateList({ silent: true })).rejects.toThrow(
				"Repository not initialized",
			)
		} finally {
			process.chdir(originalCwd)
		}
	})
})
