import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { join } from "path"
import { next } from "./next"
import {
	createTempDir,
	cleanupTempDir,
	initGitRepo,
	getCurrentBranch,
	createCommit,
	checkoutBranch,
	addAndCommit,
	runTestEffect,
	fileExists,
	getGitOutput,
} from "../test-utils"

// Cache the git-filter-repo availability check
let hasGitFilterRepoCache: boolean | null = null
async function checkGitFilterRepo(): Promise<boolean> {
	if (hasGitFilterRepoCache === null) {
		const proc = Bun.spawn(["which", "git-filter-repo"], {
			stdout: "pipe",
			stderr: "pipe",
		})
		await proc.exited
		hasGitFilterRepoCache = proc.exitCode === 0
	}
	return hasGitFilterRepoCache
}

async function createBranch(cwd: string, branchName: string): Promise<void> {
	await Bun.spawn(["git", "checkout", "-b", branchName], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	}).exited
}

async function setupAgencyJson(
	gitRoot: string,
	baseBranch?: string,
	emitBranch?: string,
): Promise<void> {
	const agencyJson = {
		version: 1,
		injectedFiles: ["AGENTS.md", "TASK.md"],
		template: "test",
		createdAt: new Date().toISOString(),
		...(baseBranch ? { baseBranch } : {}),
		...(emitBranch ? { emitBranch } : {}),
	}
	await Bun.write(
		join(gitRoot, "agency.json"),
		JSON.stringify(agencyJson, null, 2) + "\n",
	)
	await Bun.spawn(["git", "add", "agency.json"], {
		cwd: gitRoot,
		stdout: "pipe",
		stderr: "pipe",
	}).exited
	await Bun.spawn(["git", "commit", "--no-verify", "-m", "Add agency.json"], {
		cwd: gitRoot,
		stdout: "pipe",
		stderr: "pipe",
	}).exited
}

describe("next command", () => {
	let tempDir: string
	let originalCwd: string
	let hasGitFilterRepo: boolean

	beforeEach(async () => {
		tempDir = await createTempDir()
		originalCwd = process.cwd()
		process.chdir(tempDir)

		// Set config path to non-existent file to use defaults
		process.env.AGENCY_CONFIG_PATH = join(tempDir, "non-existent-config.json")

		// Check if git-filter-repo is available
		hasGitFilterRepo = await checkGitFilterRepo()

		// Initialize git repo with initial commit on main
		await initGitRepo(tempDir)
		await Bun.write(join(tempDir, "initial.txt"), "initial content\n")
		await Bun.spawn(["git", "add", "initial.txt"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited
		await Bun.spawn(["git", "commit", "--no-verify", "-m", "Initial commit"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited
	})

	afterEach(async () => {
		process.chdir(originalCwd)
		await cleanupTempDir(tempDir)
		delete process.env.AGENCY_CONFIG_PATH
	})

	describe("precondition checks", () => {
		test("fails when not on an agency source branch", async () => {
			// Should fail on main branch without agency.json
			expect(
				runTestEffect(
					next({
						silent: true,
						verbose: false,
					}),
				),
			).rejects.toThrow(/does not have agency\.json/)
		})

		test("fails when there are uncommitted changes", async () => {
			// Create feature branch with agency.json
			await createBranch(tempDir, "agency/feature")
			await setupAgencyJson(tempDir, "main")

			// Create uncommitted changes
			await Bun.write(join(tempDir, "uncommitted.txt"), "uncommitted\n")

			expect(
				runTestEffect(
					next({
						silent: true,
						verbose: false,
					}),
				),
			).rejects.toThrow(/uncommitted changes/)
		})

		test("throws error when git-filter-repo is not installed", async () => {
			if (hasGitFilterRepo) {
				// Skip this test if git-filter-repo IS installed
				return
			}

			await createBranch(tempDir, "agency/feature")
			await setupAgencyJson(tempDir, "main")

			expect(
				runTestEffect(
					next({
						silent: true,
					}),
				),
			).rejects.toThrow("git-filter-repo is not installed")
		})
	})

	describe("filtering integration (requires git-filter-repo)", () => {
		test("filters branch to keep only agency files", async () => {
			if (!hasGitFilterRepo) {
				console.log("Skipping test: git-filter-repo not installed")
				return
			}

			// Create feature branch with agency files and work files
			await createBranch(tempDir, "agency/feature")
			await setupAgencyJson(tempDir, "main", "feature")

			// Add agency files
			await Bun.write(join(tempDir, "TASK.md"), "# Task\nTest task\n")
			await Bun.write(join(tempDir, "AGENTS.md"), "# Agents\nTest agents\n")
			await addAndCommit(tempDir, "TASK.md AGENTS.md", "Add agency files")

			// Add work files (these should be filtered out)
			await Bun.write(join(tempDir, "feature.ts"), "export const x = 1\n")
			await addAndCommit(tempDir, "feature.ts", "Add feature code")

			// Simulate the work being merged to main
			await checkoutBranch(tempDir, "main")
			await Bun.write(join(tempDir, "feature.ts"), "export const x = 1\n")
			await addAndCommit(tempDir, "feature.ts", "Merge feature (simulated)")

			// Go back to feature branch and run next
			await checkoutBranch(tempDir, "agency/feature")

			await runTestEffect(
				next({
					silent: true,
					baseBranch: "main",
				}),
			)

			// Verify we're still on the feature branch
			const currentBranch = await getCurrentBranch(tempDir)
			expect(currentBranch).toBe("agency/feature")

			// Verify agency files exist
			expect(await fileExists(join(tempDir, "agency.json"))).toBe(true)
			expect(await fileExists(join(tempDir, "TASK.md"))).toBe(true)
			expect(await fileExists(join(tempDir, "AGENTS.md"))).toBe(true)

			// Verify work file exists (from rebased main)
			expect(await fileExists(join(tempDir, "feature.ts"))).toBe(true)

			// Verify the commit history - agency file commits should be present
			const logOutput = await getGitOutput(tempDir, [
				"log",
				"--oneline",
				"main..agency/feature",
			])
			expect(logOutput).toContain("Add agency files")
			expect(logOutput).toContain("Add agency.json")
			// Work commit should NOT be in the filtered branch
			expect(logOutput).not.toContain("Add feature code")
		})

		test("preserves agency file content after filtering", async () => {
			if (!hasGitFilterRepo) {
				console.log("Skipping test: git-filter-repo not installed")
				return
			}

			// Create feature branch
			await createBranch(tempDir, "agency/feature")
			await setupAgencyJson(tempDir, "main", "feature")

			// Add agency files with specific content
			const taskContent = "# My Task\n\nThis is important context.\n"
			await Bun.write(join(tempDir, "TASK.md"), taskContent)
			await addAndCommit(tempDir, "TASK.md", "Add TASK.md")

			// Add work files
			await Bun.write(join(tempDir, "work.ts"), "// work\n")
			await addAndCommit(tempDir, "work.ts", "Add work")

			// Simulate merge to main
			await checkoutBranch(tempDir, "main")
			await Bun.write(join(tempDir, "work.ts"), "// work\n")
			await addAndCommit(tempDir, "work.ts", "Merge work")

			// Run next
			await checkoutBranch(tempDir, "agency/feature")
			await runTestEffect(
				next({
					silent: true,
					baseBranch: "main",
				}),
			)

			// Verify TASK.md content is preserved
			const actualContent = await Bun.file(join(tempDir, "TASK.md")).text()
			expect(actualContent).toBe(taskContent)
		})

		test("uses base branch from agency.json by default", async () => {
			if (!hasGitFilterRepo) {
				console.log("Skipping test: git-filter-repo not installed")
				return
			}

			// Create a develop branch
			await createBranch(tempDir, "develop")
			await Bun.write(join(tempDir, "dev.txt"), "dev\n")
			await addAndCommit(tempDir, "dev.txt", "Dev commit")

			// Create feature branch from develop with agency.json pointing to develop
			await createBranch(tempDir, "agency/feature")
			await setupAgencyJson(tempDir, "develop", "feature")

			await Bun.write(join(tempDir, "TASK.md"), "# Task\n")
			await addAndCommit(tempDir, "TASK.md", "Add TASK.md")

			await Bun.write(join(tempDir, "work.ts"), "// work\n")
			await addAndCommit(tempDir, "work.ts", "Add work")

			// Update develop (simulate merge)
			await checkoutBranch(tempDir, "develop")
			await Bun.write(join(tempDir, "work.ts"), "// work\n")
			await addAndCommit(tempDir, "work.ts", "Merge work")

			// Run next without specifying base branch (should use develop from agency.json)
			await checkoutBranch(tempDir, "agency/feature")
			await runTestEffect(
				next({
					silent: true,
				}),
			)

			// Verify we have dev.txt from develop
			expect(await fileExists(join(tempDir, "dev.txt"))).toBe(true)
		})

		test("can specify explicit base branch", async () => {
			if (!hasGitFilterRepo) {
				console.log("Skipping test: git-filter-repo not installed")
				return
			}

			// Create custom-base branch
			await createBranch(tempDir, "custom-base")
			await Bun.write(join(tempDir, "custom.txt"), "custom\n")
			await addAndCommit(tempDir, "custom.txt", "Custom base commit")

			// Create feature branch from main
			await checkoutBranch(tempDir, "main")
			await createBranch(tempDir, "agency/feature")
			await setupAgencyJson(tempDir, "main", "feature")

			await Bun.write(join(tempDir, "TASK.md"), "# Task\n")
			await addAndCommit(tempDir, "TASK.md", "Add TASK.md")

			// Run next onto custom-base instead of main
			await runTestEffect(
				next({
					silent: true,
					baseBranch: "custom-base",
				}),
			)

			// Verify custom.txt exists (from custom-base)
			expect(await fileExists(join(tempDir, "custom.txt"))).toBe(true)
		})

		test("handles multiple work commits correctly", async () => {
			if (!hasGitFilterRepo) {
				console.log("Skipping test: git-filter-repo not installed")
				return
			}

			// Create feature branch
			await createBranch(tempDir, "agency/feature")
			await setupAgencyJson(tempDir, "main", "feature")

			// Add agency files
			await Bun.write(join(tempDir, "TASK.md"), "# Task\n")
			await addAndCommit(tempDir, "TASK.md", "Add TASK.md")

			// Add multiple work commits
			await Bun.write(join(tempDir, "work1.ts"), "// work 1\n")
			await addAndCommit(tempDir, "work1.ts", "Add work 1")

			await Bun.write(join(tempDir, "work2.ts"), "// work 2\n")
			await addAndCommit(tempDir, "work2.ts", "Add work 2")

			await Bun.write(join(tempDir, "work3.ts"), "// work 3\n")
			await addAndCommit(tempDir, "work3.ts", "Add work 3")

			// Simulate merge to main
			await checkoutBranch(tempDir, "main")
			await Bun.write(join(tempDir, "work1.ts"), "// work 1\n")
			await Bun.write(join(tempDir, "work2.ts"), "// work 2\n")
			await Bun.write(join(tempDir, "work3.ts"), "// work 3\n")
			await addAndCommit(tempDir, "work1.ts work2.ts work3.ts", "Merge all work")

			// Run next
			await checkoutBranch(tempDir, "agency/feature")
			await runTestEffect(
				next({
					silent: true,
					baseBranch: "main",
				}),
			)

			// Verify commit history - all work commits should be filtered out
			const logOutput = await getGitOutput(tempDir, [
				"log",
				"--oneline",
				"main..agency/feature",
			])
			expect(logOutput).not.toContain("Add work 1")
			expect(logOutput).not.toContain("Add work 2")
			expect(logOutput).not.toContain("Add work 3")
			// Agency commits should remain
			expect(logOutput).toContain("Add TASK.md")
		})
	})

	describe("error handling", () => {
		test("throws error when not in a git repository", async () => {
			const nonGitDir = await createTempDir()
			process.chdir(nonGitDir)

			expect(runTestEffect(next({ silent: true }))).rejects.toThrow(
				"Not in a git repository",
			)

			await cleanupTempDir(nonGitDir)
		})
	})
})
