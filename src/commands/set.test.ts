import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { set, setBase } from "./set"
import { createTempDir, cleanupTempDir, initGitRepo } from "../test-utils"
import { getBaseBranchConfig } from "../utils/git"
import { join } from "path"

describe("set", () => {
	let testDir: string
	let originalCwd: string

	beforeEach(async () => {
		originalCwd = process.cwd()
		testDir = await createTempDir()
		await initGitRepo(testDir)
		process.chdir(testDir)
	})

	afterEach(async () => {
		process.chdir(originalCwd)
		await cleanupTempDir(testDir)
	})

	test("sets base branch for current branch", async () => {
		// Create a feature branch
		await Bun.spawn(["git", "checkout", "-b", "feature"], {
			cwd: testDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited

		// Set base branch
		await setBase({
			baseBranch: "main",
			silent: true,
		})

		// Verify it was saved
		const savedBase = await getBaseBranchConfig("feature", testDir)
		expect(savedBase).toBe("main")
	})

	test("throws error if not in git repository", async () => {
		process.chdir(join(testDir, ".."))

		await expect(
			setBase({
				baseBranch: "main",
				silent: true,
			}),
		).rejects.toThrow("Not in a git repository")
	})

	test("throws error if base branch does not exist", async () => {
		await Bun.spawn(["git", "checkout", "-b", "feature"], {
			cwd: testDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited

		await expect(
			setBase({
				baseBranch: "nonexistent",
				silent: true,
			}),
		).rejects.toThrow("does not exist")
	})

	test("updates existing base branch configuration", async () => {
		// Create a feature branch
		await Bun.spawn(["git", "checkout", "-b", "feature"], {
			cwd: testDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited

		// Create develop branch
		await Bun.spawn(["git", "checkout", "-b", "develop", "main"], {
			cwd: testDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited

		await Bun.spawn(["git", "checkout", "feature"], {
			cwd: testDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited

		// Set initial base branch
		await setBase({
			baseBranch: "main",
			silent: true,
		})

		// Update to different base branch
		await setBase({
			baseBranch: "develop",
			silent: true,
		})

		// Verify it was updated
		const savedBase = await getBaseBranchConfig("feature", testDir)
		expect(savedBase).toBe("develop")
	})

	test("works with verbose flag", async () => {
		await Bun.spawn(["git", "checkout", "-b", "feature"], {
			cwd: testDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited

		// Should not throw
		await setBase({
			baseBranch: "main",
			silent: false,
			verbose: true,
		})

		const savedBase = await getBaseBranchConfig("feature", testDir)
		expect(savedBase).toBe("main")
	})

	test("works with silent flag", async () => {
		await Bun.spawn(["git", "checkout", "-b", "feature"], {
			cwd: testDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited

		// Should not throw and should not output anything
		await setBase({
			baseBranch: "main",
			silent: true,
		})

		const savedBase = await getBaseBranchConfig("feature", testDir)
		expect(savedBase).toBe("main")
	})

	test("each branch can have its own base branch", async () => {
		// Create feature1 branch
		await Bun.spawn(["git", "checkout", "-b", "feature1"], {
			cwd: testDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited

		await setBase({
			baseBranch: "main",
			silent: true,
		})

		// Create feature2 branch
		await Bun.spawn(["git", "checkout", "main"], {
			cwd: testDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited

		await Bun.spawn(["git", "checkout", "-b", "feature2"], {
			cwd: testDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited

		// Create develop branch
		await Bun.spawn(["git", "checkout", "-b", "develop", "main"], {
			cwd: testDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited

		await Bun.spawn(["git", "checkout", "feature2"], {
			cwd: testDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited

		await setBase({
			baseBranch: "develop",
			silent: true,
		})

		// Verify each has its own base
		const feature1Base = await getBaseBranchConfig("feature1", testDir)
		const feature2Base = await getBaseBranchConfig("feature2", testDir)

		expect(feature1Base).toBe("main")
		expect(feature2Base).toBe("develop")
	})

	test("set command with base subcommand works", async () => {
		await Bun.spawn(["git", "checkout", "-b", "feature"], {
			cwd: testDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited

		await set({
			subcommand: "base",
			args: ["main"],
			silent: true,
		})

		const savedBase = await getBaseBranchConfig("feature", testDir)
		expect(savedBase).toBe("main")
	})

	test("set command throws error without subcommand", async () => {
		await expect(
			set({
				args: [],
				silent: true,
			}),
		).rejects.toThrow("Subcommand is required")
	})

	test("set command throws error with unknown subcommand", async () => {
		await expect(
			set({
				subcommand: "unknown",
				args: [],
				silent: true,
			}),
		).rejects.toThrow("Unknown subcommand")
	})

	test("set base throws error without branch argument", async () => {
		await expect(
			set({
				subcommand: "base",
				args: [],
				silent: true,
			}),
		).rejects.toThrow("Base branch argument is required")
	})
})
