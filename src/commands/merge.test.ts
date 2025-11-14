import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { join } from "path"
import { merge } from "./merge"
import { pr } from "./pr"
import { task } from "./task"
import { createTempDir, cleanupTempDir, initGitRepo } from "../test-utils"

async function getGitOutput(cwd: string, args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	})
	await proc.exited
	return await new Response(proc.stdout).text()
}

async function getCurrentBranch(cwd: string): Promise<string> {
	const output = await getGitOutput(cwd, ["branch", "--show-current"])
	return output.trim()
}

async function createCommit(cwd: string, message: string): Promise<void> {
	// Create a test file and commit it
	await Bun.write(join(cwd, `${Date.now()}.txt`), message)
	await Bun.spawn(["git", "add", "."], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	}).exited
	await Bun.spawn(["git", "commit", "--no-verify", "-m", message], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	}).exited
}

async function isGitFilterRepoAvailable(): Promise<boolean> {
	const proc = Bun.spawn(["which", "git-filter-repo"], {
		stdout: "pipe",
		stderr: "pipe",
	})
	await proc.exited
	return proc.exitCode === 0
}

async function branchExists(cwd: string, branch: string): Promise<boolean> {
	const proc = Bun.spawn(["git", "rev-parse", "--verify", branch], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	})
	await proc.exited
	return proc.exitCode === 0
}

// Cache the git-filter-repo availability check (it doesn't change during test run)
let hasGitFilterRepoCache: boolean | null = null
async function checkGitFilterRepo(): Promise<boolean> {
	if (hasGitFilterRepoCache === null) {
		hasGitFilterRepoCache = await isGitFilterRepoAvailable()
	}
	return hasGitFilterRepoCache
}

describe("merge command", () => {
	let tempDir: string
	let originalCwd: string
	let hasGitFilterRepo: boolean

	beforeEach(async () => {
		tempDir = await createTempDir()
		originalCwd = process.cwd()
		process.chdir(tempDir)

		// Set config path to non-existent file to use defaults
		process.env.AGENCY_CONFIG_PATH = join(tempDir, "non-existent-config.json")
		// Set config dir to temp dir to avoid picking up user's config files
		process.env.AGENCY_CONFIG_DIR = await createTempDir()

		// Check if git-filter-repo is available (cached)
		hasGitFilterRepo = await checkGitFilterRepo()

		// Initialize git repo with main branch (already includes initial commit)
		await initGitRepo(tempDir)

		// Set up origin for git-filter-repo
		await Bun.spawn(["git", "remote", "add", "origin", tempDir], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited
		await Bun.spawn(["git", "fetch", "origin"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited

		// Create a feature branch
		await Bun.spawn(["git", "checkout", "-b", "feature"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited

		// Initialize AGENTS.md on feature branch
		await task({ silent: true, template: "test" })
		await Bun.spawn(["git", "add", "AGENTS.md"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited
		await Bun.spawn(["git", "commit", "--no-verify", "-m", "Add AGENTS.md"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited

		// Create another commit on feature branch
		await createCommit(tempDir, "Feature work")
	})

	afterEach(async () => {
		process.chdir(originalCwd)
		delete process.env.AGENCY_CONFIG_PATH
		if (process.env.AGENCY_CONFIG_DIR) {
			await cleanupTempDir(process.env.AGENCY_CONFIG_DIR)
			delete process.env.AGENCY_CONFIG_DIR
		}
		await cleanupTempDir(tempDir)
	})

	describe("merge from source branch", () => {
		test("creates PR branch and merges when run from source branch", async () => {
			if (!hasGitFilterRepo) {
				console.log("Skipping test: git-filter-repo not installed")
				return
			}

			// We're on feature branch (source)
			const currentBranch = await getCurrentBranch(tempDir)
			expect(currentBranch).toBe("feature")

			// Run merge - should create feature--PR and merge it to main
			await merge({ silent: true })

			// Should be on main branch after merge
			const afterMergeBranch = await getCurrentBranch(tempDir)
			expect(afterMergeBranch).toBe("main")

			// PR branch should exist
			const prExists = await branchExists(tempDir, "feature--PR")
			expect(prExists).toBe(true)

			// Main should have the feature work but not AGENTS.md
			const files = await getGitOutput(tempDir, ["ls-files"])
			expect(files).not.toContain("AGENTS.md")
		})

		test("recreates PR branch if it already exists", async () => {
			if (!hasGitFilterRepo) {
				console.log("Skipping test: git-filter-repo not installed")
				return
			}

			// Create PR branch first
			await pr({ silent: true })

			// Go back to feature branch
			await Bun.spawn(["git", "checkout", "feature"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited

			// Make additional changes
			await createCommit(tempDir, "More feature work")

			// Run merge - should recreate PR branch with new changes
			await merge({ silent: true })

			// Should be on main after merge
			const currentBranch = await getCurrentBranch(tempDir)
			expect(currentBranch).toBe("main")
		})
	})

	describe("merge from PR branch", () => {
		test("merges PR branch directly when run from PR branch", async () => {
			if (!hasGitFilterRepo) {
				console.log("Skipping test: git-filter-repo not installed")
				return
			}

			// Create PR branch
			await pr({ silent: true })

			// We're on feature--PR now
			const currentBranch = await getCurrentBranch(tempDir)
			expect(currentBranch).toBe("feature--PR")

			// Run merge - should merge feature--PR to main
			await merge({ silent: true })

			// Should be on main after merge
			const afterMergeBranch = await getCurrentBranch(tempDir)
			expect(afterMergeBranch).toBe("main")

			// Main should have the feature work but not AGENTS.md
			const files = await getGitOutput(tempDir, ["ls-files"])
			expect(files).not.toContain("AGENTS.md")
		})

		test("throws error if PR branch has no corresponding source branch", async () => {
			if (!hasGitFilterRepo) {
				console.log("Skipping test: git-filter-repo not installed")
				return
			}

			// Create PR branch
			await pr({ silent: true })

			// Delete the source branch
			await Bun.spawn(["git", "branch", "-D", "feature"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited

			// Try to merge - should fail
			expect(merge({ silent: true })).rejects.toThrow("source branch")
		})

		test("throws error if base branch config is missing", async () => {
			if (!hasGitFilterRepo) {
				console.log("Skipping test: git-filter-repo not installed")
				return
			}

			// Create PR branch
			await pr({ silent: true })

			// Manually remove the base branch config
			await Bun.spawn(
				["git", "config", "--unset", "agency.pr.feature.baseBranch"],
				{
					cwd: tempDir,
					stdout: "pipe",
					stderr: "pipe",
				},
			).exited

			// Try to merge - should fail
			expect(merge({ silent: true })).rejects.toThrow(
				"No base branch configuration found",
			)
		})
	})

	describe("error handling", () => {
		test("throws error when not in a git repository", async () => {
			const nonGitDir = await createTempDir()
			process.chdir(nonGitDir)

			expect(merge({ silent: true })).rejects.toThrow("Not in a git repository")

			await cleanupTempDir(nonGitDir)
		})

		test("throws error if base branch does not exist locally", async () => {
			if (!hasGitFilterRepo) {
				console.log("Skipping test: git-filter-repo not installed")
				return
			}

			// Create PR branch
			await pr({ silent: true })

			// Delete main branch (the base)
			await Bun.spawn(["git", "checkout", "feature--PR"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited
			await Bun.spawn(["git", "branch", "-D", "main"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited

			// Try to merge - should fail
			expect(merge({ silent: true })).rejects.toThrow("does not exist locally")
		})
	})

	describe("silent mode", () => {
		test("silent flag suppresses output", async () => {
			if (!hasGitFilterRepo) {
				console.log("Skipping test: git-filter-repo not installed")
				return
			}

			const logs: string[] = []
			const originalLog = console.log
			console.log = (...args: any[]) => logs.push(args.join(" "))

			await merge({ silent: true })

			console.log = originalLog

			expect(logs.length).toBe(0)
		})
	})
})
