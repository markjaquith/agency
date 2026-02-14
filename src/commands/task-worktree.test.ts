import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { join } from "path"
import { realpath } from "fs/promises"
import { existsSync } from "fs"
import { task } from "../commands/task"
import { worktreeList } from "../commands/worktree"
import { AGENCY_WORKTREES_DIR } from "../constants"
import { clearCommonConfigFileCache } from "../services/GitService"
import {
	createTempDir,
	cleanupTempDir,
	initGitRepo,
	initAgency,
	fileExists,
	readFile,
	runTestEffect,
	getCurrentBranch,
	getGitOutput,
	branchExists,
} from "../test-utils"

describe("task --worktree", () => {
	let tempDir: string
	let originalCwd: string
	let originalConfigDir: string | undefined

	beforeEach(async () => {
		// Resolve realpath to handle macOS /tmp -> /private/tmp symlink
		tempDir = await realpath(await createTempDir())
		originalCwd = process.cwd()
		originalConfigDir = process.env.AGENCY_CONFIG_DIR
		process.env.AGENCY_CONFIG_DIR = await createTempDir()
	})

	afterEach(async () => {
		process.chdir(originalCwd)
		clearCommonConfigFileCache()
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
		// Clean up worktrees before removing temp dir
		try {
			const proc = Bun.spawn(["git", "worktree", "prune"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			})
			await proc.exited
		} catch {
			// Ignore
		}
		await cleanupTempDir(tempDir)
	})

	test("creates a worktree in .agency-worktrees/", async () => {
		await initGitRepo(tempDir)
		process.chdir(tempDir)
		await initAgency(tempDir, "test")

		await runTestEffect(
			task({ silent: true, emit: "my-feature", worktree: true, from: "main" }),
		)

		const worktreePath = join(tempDir, AGENCY_WORKTREES_DIR, "my-feature")
		// Note: fileExists uses Bun.file().exists() which doesn't work for directories
		expect(existsSync(worktreePath)).toBe(true)
		expect(await fileExists(join(worktreePath, "AGENTS.md"))).toBe(true)
		expect(await fileExists(join(worktreePath, "TASK.md"))).toBe(true)
		expect(await fileExists(join(worktreePath, "agency.json"))).toBe(true)
	})

	test("creates source branch in the worktree", async () => {
		await initGitRepo(tempDir)
		process.chdir(tempDir)
		await initAgency(tempDir, "test")

		await runTestEffect(
			task({ silent: true, emit: "my-feature", worktree: true, from: "main" }),
		)

		const worktreePath = join(tempDir, AGENCY_WORKTREES_DIR, "my-feature")
		const branch = await getCurrentBranch(worktreePath)
		expect(branch).toBe("agency--my-feature")
	})

	test("main repo stays on original branch", async () => {
		await initGitRepo(tempDir)
		process.chdir(tempDir)
		await initAgency(tempDir, "test")

		const originalBranch = await getCurrentBranch(tempDir)

		await runTestEffect(
			task({ silent: true, emit: "my-feature", worktree: true, from: "main" }),
		)

		const currentBranch = await getCurrentBranch(tempDir)
		expect(currentBranch).toBe(originalBranch)
	})

	test("adds .agency-worktrees/ to .git/info/exclude", async () => {
		await initGitRepo(tempDir)
		process.chdir(tempDir)
		await initAgency(tempDir, "test")

		await runTestEffect(
			task({ silent: true, emit: "my-feature", worktree: true, from: "main" }),
		)

		const excludeContent = await readFile(
			join(tempDir, ".git", "info", "exclude"),
		)
		expect(excludeContent).toContain(".agency-worktrees/")
	})

	test("agency.json in worktree has correct metadata", async () => {
		await initGitRepo(tempDir)
		process.chdir(tempDir)
		await initAgency(tempDir, "test")

		await runTestEffect(
			task({ silent: true, emit: "my-feature", worktree: true, from: "main" }),
		)

		const worktreePath = join(tempDir, AGENCY_WORKTREES_DIR, "my-feature")
		const metadata = JSON.parse(
			await readFile(join(worktreePath, "agency.json")),
		)
		expect(metadata.emitBranch).toBe("my-feature")
		expect(metadata.version).toBe(1)
	})

	test("task description is written to TASK.md", async () => {
		await initGitRepo(tempDir)
		process.chdir(tempDir)
		await initAgency(tempDir, "test")

		await runTestEffect(
			task({
				silent: true,
				emit: "my-feature",
				worktree: true,
				from: "main",
				task: "Build the thing",
			}),
		)

		const worktreePath = join(tempDir, AGENCY_WORKTREES_DIR, "my-feature")
		const content = await readFile(join(worktreePath, "TASK.md"))
		expect(content).toContain("Build the thing")
	})

	test("rejects --worktree with --from-current", async () => {
		await initGitRepo(tempDir)
		process.chdir(tempDir)
		await initAgency(tempDir, "test")

		expect(
			runTestEffect(
				task({
					silent: true,
					emit: "my-feature",
					worktree: true,
					fromCurrent: true,
				}),
			),
		).rejects.toThrow("Cannot use --worktree with --from-current")
	})

	test("rejects --worktree with --continue", async () => {
		await initGitRepo(tempDir)
		process.chdir(tempDir)
		await initAgency(tempDir, "test")

		expect(
			runTestEffect(
				task({
					silent: true,
					emit: "my-feature",
					worktree: true,
					continue: true,
				}),
			),
		).rejects.toThrow("Cannot use --worktree with --continue")
	})

	test("git worktree list shows the worktree", async () => {
		await initGitRepo(tempDir)
		process.chdir(tempDir)
		await initAgency(tempDir, "test")

		await runTestEffect(
			task({ silent: true, emit: "my-feature", worktree: true, from: "main" }),
		)

		const output = await getGitOutput(tempDir, ["worktree", "list"])
		expect(output).toContain("my-feature")
		expect(output).toContain("agency--my-feature")
	})
})

describe("worktree list command", () => {
	let tempDir: string
	let originalCwd: string
	let originalConfigDir: string | undefined

	beforeEach(async () => {
		tempDir = await realpath(await createTempDir())
		originalCwd = process.cwd()
		originalConfigDir = process.env.AGENCY_CONFIG_DIR
		process.env.AGENCY_CONFIG_DIR = await createTempDir()
	})

	afterEach(async () => {
		process.chdir(originalCwd)
		clearCommonConfigFileCache()
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
		try {
			const proc = Bun.spawn(["git", "worktree", "prune"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			})
			await proc.exited
		} catch {
			// Ignore
		}
		await cleanupTempDir(tempDir)
	})

	test("shows no worktrees when none exist", async () => {
		await initGitRepo(tempDir)
		process.chdir(tempDir)

		// Should not throw
		await runTestEffect(worktreeList({ silent: true }))
	})

	test("lists worktrees after creation", async () => {
		await initGitRepo(tempDir)
		process.chdir(tempDir)
		await initAgency(tempDir, "test")

		await runTestEffect(
			task({ silent: true, emit: "feat-a", worktree: true, from: "main" }),
		)
		await runTestEffect(
			task({ silent: true, emit: "feat-b", worktree: true, from: "main" }),
		)

		// Just verify it doesn't crash - output goes to console
		await runTestEffect(worktreeList({ silent: true }))

		// Verify both worktrees exist (use existsSync since these are directories)
		expect(existsSync(join(tempDir, AGENCY_WORKTREES_DIR, "feat-a"))).toBe(true)
		expect(existsSync(join(tempDir, AGENCY_WORKTREES_DIR, "feat-b"))).toBe(true)
	}, 15000)
})
