import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { join } from "path"
import { merge } from "./merge"
import { pr } from "./pr"
import { task } from "./task"
import {
	createTempDir,
	cleanupTempDir,
	initGitRepo,
	initAgency,
	getGitOutput,
	getCurrentBranch,
	createCommit,
	branchExists,
	runTestEffect,
} from "../test-utils"

async function isGitFilterRepoAvailable(): Promise<boolean> {
	const proc = Bun.spawn(["which", "git-filter-repo"], {
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
		await initAgency(tempDir, "test")

		await runTestEffect(task({ silent: true }))

		// Ensure agency.json has baseBranch set (task should auto-detect it, but ensure it's there)
		const agencyJsonPath = join(tempDir, "agency.json")
		const agencyJson = await Bun.file(agencyJsonPath).json()
		if (!agencyJson.baseBranch) {
			agencyJson.baseBranch = "origin/main"
			await Bun.write(
				agencyJsonPath,
				JSON.stringify(agencyJson, null, 2) + "\n",
			)
		}

		await Bun.spawn(["git", "add", "AGENTS.md", "agency.json"], {
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
			await runTestEffect(merge({ silent: true }))

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
			await runTestEffect(pr({ silent: true }))

			// Go back to feature branch
			await Bun.spawn(["git", "checkout", "feature"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited

			// Make additional changes
			await createCommit(tempDir, "More feature work")

			// Run merge - should recreate PR branch with new changes
			await runTestEffect(merge({ silent: true }))

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
			await runTestEffect(pr({ silent: true }))

			// We're on feature--PR now
			const currentBranch = await getCurrentBranch(tempDir)
			expect(currentBranch).toBe("feature--PR")

			// Run merge - should merge feature--PR to main
			await runTestEffect(merge({ silent: true }))

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
			await runTestEffect(pr({ silent: true }))

			// Delete the source branch
			await Bun.spawn(["git", "branch", "-D", "feature"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited

			// Try to merge - should fail
			await expect(runTestEffect(merge({ silent: true }))).rejects.toThrow(
				"source branch",
			)
		})
	})

	describe("error handling", () => {
		test("throws error when not in a git repository", async () => {
			const nonGitDir = await createTempDir()
			process.chdir(nonGitDir)

			await expect(runTestEffect(merge({ silent: true }))).rejects.toThrow(
				"Not in a git repository",
			)

			await cleanupTempDir(nonGitDir)
		})

		test("throws error if base branch does not exist locally", async () => {
			if (!hasGitFilterRepo) {
				console.log("Skipping test: git-filter-repo not installed")
				return
			}

			// Create PR branch
			await runTestEffect(pr({ silent: true }))

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
			await expect(runTestEffect(merge({ silent: true }))).rejects.toThrow(
				"does not exist locally",
			)
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

			await runTestEffect(merge({ silent: true }))

			console.log = originalLog

			expect(logs.length).toBe(0)
		})
	})

	describe("squash merge", () => {
		test("performs squash merge when --squash flag is set", async () => {
			if (!hasGitFilterRepo) {
				console.log("Skipping test: git-filter-repo not installed")
				return
			}

			// We're on feature branch (source)
			const currentBranch = await getCurrentBranch(tempDir)
			expect(currentBranch).toBe("feature")

			// Run merge with squash flag
			await runTestEffect(merge({ silent: true, squash: true }))

			// Should be on main branch after merge
			const afterMergeBranch = await getCurrentBranch(tempDir)
			expect(afterMergeBranch).toBe("main")

			// Check that changes are staged but not committed
			// Get the git status to see if there are staged changes
			const statusProc = Bun.spawn(["git", "status", "--porcelain"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			})
			await statusProc.exited
			const status = await new Response(statusProc.stdout).text()

			// Staged changes should be present (indicated by status codes in first column)
			expect(status.trim().length).toBeGreaterThan(0)

			// Get the log to verify no merge commit was created
			const logProc = Bun.spawn(["git", "log", "--oneline", "-5"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			})
			await logProc.exited
			const log = await new Response(logProc.stdout).text()

			// Should not contain a merge commit message
			expect(log).not.toContain("Merge branch")
		})

		test("performs regular merge when --squash flag is not set", async () => {
			if (!hasGitFilterRepo) {
				console.log("Skipping test: git-filter-repo not installed")
				return
			}

			// We're on feature branch (source)
			const currentBranch = await getCurrentBranch(tempDir)
			expect(currentBranch).toBe("feature")

			// Run merge without squash flag
			await runTestEffect(merge({ silent: true, squash: false }))

			// Should be on main branch after merge
			const afterMergeBranch = await getCurrentBranch(tempDir)
			expect(afterMergeBranch).toBe("main")

			// With regular merge (not squash), there should be no staged changes
			const statusProc = Bun.spawn(["git", "status", "--porcelain"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			})
			await statusProc.exited
			const status = await new Response(statusProc.stdout).text()

			// No staged changes - everything should be committed
			expect(status.trim().length).toBe(0)

			// Get the log to verify commits were included
			const logProc = Bun.spawn(["git", "log", "--oneline", "-5"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			})
			await logProc.exited
			const log = await new Response(logProc.stdout).text()

			// Should contain the feature work commit (regular merge includes all commits)
			expect(log).toContain("Feature work")
		})
	})

	describe("push flag", () => {
		test("pushes base branch to origin when --push flag is set", async () => {
			if (!hasGitFilterRepo) {
				console.log("Skipping test: git-filter-repo not installed")
				return
			}

			// We're on feature branch (source)
			const currentBranch = await getCurrentBranch(tempDir)
			expect(currentBranch).toBe("feature")

			// Get the current commit on main before merge
			await Bun.spawn(["git", "checkout", "main"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited
			const beforeCommitProc = Bun.spawn(["git", "rev-parse", "HEAD"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			})
			await beforeCommitProc.exited
			const beforeCommit = (
				await new Response(beforeCommitProc.stdout).text()
			).trim()

			// Go back to feature branch
			await Bun.spawn(["git", "checkout", "feature"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited

			// Run merge with push flag
			await runTestEffect(merge({ silent: true, push: true }))

			// Should be on main branch after merge
			const afterMergeBranch = await getCurrentBranch(tempDir)
			expect(afterMergeBranch).toBe("main")

			// Get the current commit on main after merge
			const afterCommitProc = Bun.spawn(["git", "rev-parse", "HEAD"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			})
			await afterCommitProc.exited
			const afterCommit = (
				await new Response(afterCommitProc.stdout).text()
			).trim()

			// The commit should have changed (merge happened)
			expect(afterCommit).not.toBe(beforeCommit)

			// Verify that origin/main points to the same commit as local main
			const originMainProc = Bun.spawn(["git", "rev-parse", "origin/main"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			})
			await originMainProc.exited
			const originMainCommit = (
				await new Response(originMainProc.stdout).text()
			).trim()

			// origin/main should be at the same commit as local main (push succeeded)
			expect(originMainCommit).toBe(afterCommit)
		})

		test("does not push when --push flag is not set", async () => {
			if (!hasGitFilterRepo) {
				console.log("Skipping test: git-filter-repo not installed")
				return
			}

			// We're on feature branch (source)
			const currentBranch = await getCurrentBranch(tempDir)
			expect(currentBranch).toBe("feature")

			// Get the current commit on origin/main before merge
			const beforeOriginProc = Bun.spawn(["git", "rev-parse", "origin/main"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			})
			await beforeOriginProc.exited
			const beforeOriginCommit = (
				await new Response(beforeOriginProc.stdout).text()
			).trim()

			// Run merge without push flag
			await runTestEffect(merge({ silent: true }))

			// Should be on main branch after merge
			const afterMergeBranch = await getCurrentBranch(tempDir)
			expect(afterMergeBranch).toBe("main")

			// Get the current commit on origin/main after merge
			const afterOriginProc = Bun.spawn(["git", "rev-parse", "origin/main"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			})
			await afterOriginProc.exited
			const afterOriginCommit = (
				await new Response(afterOriginProc.stdout).text()
			).trim()

			// origin/main should still be at the same commit (no push happened)
			expect(afterOriginCommit).toBe(beforeOriginCommit)

			// But local main should have moved forward
			const localMainProc = Bun.spawn(["git", "rev-parse", "HEAD"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			})
			await localMainProc.exited
			const localMainCommit = (
				await new Response(localMainProc.stdout).text()
			).trim()

			expect(localMainCommit).not.toBe(beforeOriginCommit)
		})
	})
})
