import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { join } from "path"
import { emit } from "../commands/emit"
import { task } from "../commands/task"
import {
	createTempDir,
	cleanupTempDir,
	initGitRepo,
	initAgency,
	getGitOutput,
	getCurrentBranch,
	createCommit,
	checkoutBranch,
	createBranch,
	addAndCommit,
	setupRemote,
	runTestEffect,
} from "../test-utils"

// Cache the git-filter-repo availability check (it doesn't change during test run)
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

describe("emit command - integration tests (requires git-filter-repo)", () => {
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

		// Create a source branch (with agency-- prefix)
		await createBranch(tempDir, "agency--test-feature")

		// Initialize AGENTS.md and commit in one go
		await initAgency(tempDir, "test")

		await runTestEffect(task({ silent: true, fromCurrent: true }))
		await addAndCommit(tempDir, "AGENTS.md", "Add AGENTS.md")

		// Set up origin/main for git-filter-repo
		await setupRemote(tempDir, "origin", tempDir)
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

	test("filters AGENTS.md from emit branch", async () => {
		if (!hasGitFilterRepo) {
			console.log("Skipping test: git-filter-repo not installed")
			return
		}

		// Go back to main and create a fresh source branch
		await checkoutBranch(tempDir, "main")
		await createBranch(tempDir, "agency--feature")
		// Create agency.json with AGENTS.md as managed file
		await Bun.write(
			join(tempDir, "agency.json"),
			JSON.stringify({
				version: 1,
				injectedFiles: ["AGENTS.md"],
				template: "test",
				createdAt: new Date().toISOString(),
			}),
		)
		await Bun.write(join(tempDir, "AGENTS.md"), "# Test AGENTS\n")
		await addAndCommit(tempDir, "agency.json AGENTS.md", "Add agency files")
		// Also create a test.txt file via createCommit
		await createCommit(tempDir, "Feature commit")

		// Create emit branch (this runs git-filter-repo)
		await runTestEffect(emit({ silent: true }))

		// Should still be on feature branch
		const currentBranch = await getCurrentBranch(tempDir)
		expect(currentBranch).toBe("agency--feature")

		// Switch to emit branch to verify files
		await checkoutBranch(tempDir, "feature")

		// AGENTS.md should be filtered out
		const files = await getGitOutput(tempDir, ["ls-files"])
		expect(files).not.toContain("AGENTS.md")
		expect(files).not.toContain("AGENCY.md")

		// But test.txt should still exist
		expect(files).toContain("test.txt")
	})

	test("handles emit branch recreation after source branch rebase", async () => {
		if (!hasGitFilterRepo) {
			console.log("Skipping test: git-filter-repo not installed")
			return
		}

		// We're on test-feature which has AGENTS.md
		// Add a feature-specific file to avoid conflicts
		await Bun.write(join(tempDir, "feature.txt"), "feature content\n")
		await addAndCommit(tempDir, "feature.txt", "Add feature file")

		// Store merge-base before advancing main
		const initialMergeBase = await getGitOutput(tempDir, [
			"merge-base",
			"agency--test-feature",
			"main",
		])

		// Create initial emit branch
		await runTestEffect(emit({ silent: true, baseBranch: "main" }))

		// Should still be on test-feature branch
		let currentBranch = await getCurrentBranch(tempDir)
		expect(currentBranch).toBe("agency--test-feature")

		// Switch to emit branch to verify AGENTS.md is filtered
		await checkoutBranch(tempDir, "test-feature")

		let files = await getGitOutput(tempDir, ["ls-files"])
		expect(files).not.toContain("AGENTS.md")
		expect(files).toContain("feature.txt")

		// Switch back to source branch
		await checkoutBranch(tempDir, "agency--test-feature")

		// Simulate advancing main branch with a different file
		await checkoutBranch(tempDir, "main")
		await Bun.write(join(tempDir, "main-file.txt"), "main content\n")
		await addAndCommit(tempDir, "main-file.txt", "Main branch advancement")

		// Rebase test-feature onto new main
		await checkoutBranch(tempDir, "agency--test-feature")
		const rebaseProc = Bun.spawn(["git", "rebase", "main"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		})
		await rebaseProc.exited
		if (rebaseProc.exitCode !== 0) {
			const stderr = await new Response(rebaseProc.stderr).text()
			throw new Error(`Rebase failed: ${stderr}`)
		}

		// Verify merge-base has changed after rebase
		const newMergeBase = await getGitOutput(tempDir, [
			"merge-base",
			"agency--test-feature",
			"main",
		])
		expect(newMergeBase.trim()).not.toBe(initialMergeBase.trim())

		// Recreate emit branch after rebase (this is where the bug would manifest)
		await runTestEffect(emit({ silent: true, baseBranch: "main" }))

		// Should still be on test-feature branch
		currentBranch = await getCurrentBranch(tempDir)
		expect(currentBranch).toBe("agency--test-feature")

		// Switch to emit branch to verify files
		await checkoutBranch(tempDir, "test-feature")

		// Verify AGENTS.md is still filtered and no extraneous changes
		files = await getGitOutput(tempDir, ["ls-files"])
		expect(files).not.toContain("AGENTS.md")
		expect(files).toContain("feature.txt")
		expect(files).toContain("main-file.txt") // Should have main's file after rebase

		// Verify that our feature commits exist but AGENTS.md commit is filtered
		const logOutput = await getGitOutput(tempDir, [
			"log",
			"--oneline",
			"main..test-feature",
		])
		expect(logOutput).toContain("Add feature file")
		expect(logOutput).not.toContain("Add AGENTS.md")
	})

	test("filters pre-existing CLAUDE.md that gets edited by agency", async () => {
		if (!hasGitFilterRepo) {
			console.log("Skipping test: git-filter-repo not installed")
			return
		}

		// Start fresh on main branch
		await checkoutBranch(tempDir, "main")

		// Create CLAUDE.md on main branch (simulating pre-existing file)
		await Bun.write(
			join(tempDir, "CLAUDE.md"),
			"# Original Claude Instructions\n\nSome content here.\n",
		)
		await addAndCommit(tempDir, "CLAUDE.md", "Add CLAUDE.md")

		// Create a new feature branch
		await createBranch(tempDir, "agency--claude-test")

		// Initialize agency on this branch - first commit has agency files (NOT including CLAUDE.md)
		await Bun.write(
			join(tempDir, "agency.json"),
			JSON.stringify({
				version: 1,
				injectedFiles: ["AGENTS.md"],
				template: "test",
				createdAt: new Date().toISOString(),
			}),
		)
		await Bun.write(join(tempDir, "AGENTS.md"), "# Test AGENTS\n")
		await addAndCommit(
			tempDir,
			"agency.json AGENTS.md",
			"Initialize agency files",
		)

		// Simulate what agency task now does - CLAUDE.md modification in a separate commit
		// with AGENCY_REMOVE_COMMIT marker so the commit gets dropped during emit
		const originalClaude = await Bun.file(join(tempDir, "CLAUDE.md")).text()
		const modifiedClaude = `${originalClaude}\n# Agency References\n@AGENTS.md\n@TASK.md\n`
		await Bun.write(join(tempDir, "CLAUDE.md"), modifiedClaude)
		await addAndCommit(
			tempDir,
			"CLAUDE.md",
			"chore: agency edit CLAUDE.md\n\nAGENCY_REMOVE_COMMIT",
		)

		// Add a feature file
		await createCommit(tempDir, "Feature commit")

		// Create emit branch (this should drop the CLAUDE.md modification commit)
		await runTestEffect(emit({ silent: true, baseBranch: "main" }))

		// Should still be on source branch
		const currentBranch = await getCurrentBranch(tempDir)
		expect(currentBranch).toBe("agency--claude-test")

		// Switch to emit branch to verify CLAUDE.md is reverted to main's version
		await checkoutBranch(tempDir, "claude-test")

		const files = await getGitOutput(tempDir, ["ls-files"])
		expect(files).toContain("CLAUDE.md") // File should exist (from main)
		expect(files).not.toContain("AGENTS.md") // Should be filtered
		expect(files).not.toContain("TASK.md") // Should be filtered
		expect(files).toContain("test.txt") // Feature file should exist

		// Verify CLAUDE.md was reverted to original (no agency references)
		const claudeContent = await Bun.file(join(tempDir, "CLAUDE.md")).text()
		expect(claudeContent).toBe(
			"# Original Claude Instructions\n\nSome content here.\n",
		)
		expect(claudeContent).not.toContain("@AGENTS.md")
		expect(claudeContent).not.toContain("@TASK.md")
	})

	describe("AGENCY_REMOVE_COMMIT edge cases", () => {
		test("handles two contiguous AGENCY_REMOVE_COMMIT commits", async () => {
			if (!hasGitFilterRepo) {
				console.log("Skipping test: git-filter-repo not installed")
				return
			}

			await checkoutBranch(tempDir, "main")

			// Create two files on main that will be modified
			await Bun.write(join(tempDir, "FILE1.md"), "Original content 1\n")
			await Bun.write(join(tempDir, "FILE2.md"), "Original content 2\n")
			await addAndCommit(tempDir, "FILE1.md FILE2.md", "Add files")

			await createBranch(tempDir, "agency--contiguous-test")

			// Create agency.json
			await Bun.write(
				join(tempDir, "agency.json"),
				JSON.stringify({
					version: 1,
					injectedFiles: [],
					template: "test",
					createdAt: new Date().toISOString(),
				}),
			)
			await addAndCommit(tempDir, "agency.json", "Add agency.json")

			// Two contiguous AGENCY_REMOVE_COMMIT commits
			await Bun.write(join(tempDir, "FILE1.md"), "Modified content 1\n")
			await addAndCommit(
				tempDir,
				"FILE1.md",
				"chore: edit FILE1\n\nAGENCY_REMOVE_COMMIT",
			)

			await Bun.write(join(tempDir, "FILE2.md"), "Modified content 2\n")
			await addAndCommit(
				tempDir,
				"FILE2.md",
				"chore: edit FILE2\n\nAGENCY_REMOVE_COMMIT",
			)

			// Add a feature commit after
			await createCommit(tempDir, "Feature commit")

			await runTestEffect(emit({ silent: true, baseBranch: "main" }))
			await checkoutBranch(tempDir, "contiguous-test")

			// Both files should be reverted to original
			const file1 = await Bun.file(join(tempDir, "FILE1.md")).text()
			const file2 = await Bun.file(join(tempDir, "FILE2.md")).text()
			expect(file1).toBe("Original content 1\n")
			expect(file2).toBe("Original content 2\n")

			// Feature commit should still exist
			const files = await getGitOutput(tempDir, ["ls-files"])
			expect(files).toContain("test.txt")
		})

		test("handles two non-contiguous AGENCY_REMOVE_COMMIT commits", async () => {
			if (!hasGitFilterRepo) {
				console.log("Skipping test: git-filter-repo not installed")
				return
			}

			await checkoutBranch(tempDir, "main")

			await Bun.write(join(tempDir, "FILE1.md"), "Original content 1\n")
			await Bun.write(join(tempDir, "FILE2.md"), "Original content 2\n")
			await addAndCommit(tempDir, "FILE1.md FILE2.md", "Add files")

			await createBranch(tempDir, "agency--non-contiguous-test")

			await Bun.write(
				join(tempDir, "agency.json"),
				JSON.stringify({
					version: 1,
					injectedFiles: [],
					template: "test",
					createdAt: new Date().toISOString(),
				}),
			)
			await addAndCommit(tempDir, "agency.json", "Add agency.json")

			// First AGENCY_REMOVE_COMMIT
			await Bun.write(join(tempDir, "FILE1.md"), "Modified content 1\n")
			await addAndCommit(
				tempDir,
				"FILE1.md",
				"chore: edit FILE1\n\nAGENCY_REMOVE_COMMIT",
			)

			// Regular commit in between
			await Bun.write(join(tempDir, "feature1.txt"), "feature 1\n")
			await addAndCommit(tempDir, "feature1.txt", "Add feature 1")

			// Second AGENCY_REMOVE_COMMIT
			await Bun.write(join(tempDir, "FILE2.md"), "Modified content 2\n")
			await addAndCommit(
				tempDir,
				"FILE2.md",
				"chore: edit FILE2\n\nAGENCY_REMOVE_COMMIT",
			)

			// Another regular commit
			await Bun.write(join(tempDir, "feature2.txt"), "feature 2\n")
			await addAndCommit(tempDir, "feature2.txt", "Add feature 2")

			await runTestEffect(emit({ silent: true, baseBranch: "main" }))
			await checkoutBranch(tempDir, "non-contiguous-test")

			// Both files should be reverted to original
			const file1 = await Bun.file(join(tempDir, "FILE1.md")).text()
			const file2 = await Bun.file(join(tempDir, "FILE2.md")).text()
			expect(file1).toBe("Original content 1\n")
			expect(file2).toBe("Original content 2\n")

			// Feature commits should still exist
			const files = await getGitOutput(tempDir, ["ls-files"])
			expect(files).toContain("feature1.txt")
			expect(files).toContain("feature2.txt")
		})

		test("handles AGENCY_REMOVE_COMMIT as first commit after fork point", async () => {
			if (!hasGitFilterRepo) {
				console.log("Skipping test: git-filter-repo not installed")
				return
			}

			await checkoutBranch(tempDir, "main")

			await Bun.write(join(tempDir, "EXISTING.md"), "Original content\n")
			await addAndCommit(tempDir, "EXISTING.md", "Add existing file")

			await createBranch(tempDir, "agency--first-commit-test")

			// First commit is AGENCY_REMOVE_COMMIT (modifying existing file)
			await Bun.write(join(tempDir, "EXISTING.md"), "Modified content\n")
			await addAndCommit(
				tempDir,
				"EXISTING.md",
				"chore: edit EXISTING\n\nAGENCY_REMOVE_COMMIT",
			)

			// Then agency.json
			await Bun.write(
				join(tempDir, "agency.json"),
				JSON.stringify({
					version: 1,
					injectedFiles: [],
					template: "test",
					createdAt: new Date().toISOString(),
				}),
			)
			await addAndCommit(tempDir, "agency.json", "Add agency.json")

			// Feature commit
			await createCommit(tempDir, "Feature commit")

			await runTestEffect(emit({ silent: true, baseBranch: "main" }))
			await checkoutBranch(tempDir, "first-commit-test")

			// File should be reverted to original
			const content = await Bun.file(join(tempDir, "EXISTING.md")).text()
			expect(content).toBe("Original content\n")

			// Feature commit should exist
			const files = await getGitOutput(tempDir, ["ls-files"])
			expect(files).toContain("test.txt")
		})

		test("handles AGENCY_REMOVE_COMMIT as last commit", async () => {
			if (!hasGitFilterRepo) {
				console.log("Skipping test: git-filter-repo not installed")
				return
			}

			await checkoutBranch(tempDir, "main")

			await Bun.write(join(tempDir, "EXISTING.md"), "Original content\n")
			await addAndCommit(tempDir, "EXISTING.md", "Add existing file")

			await createBranch(tempDir, "agency--last-commit-test")

			// agency.json first
			await Bun.write(
				join(tempDir, "agency.json"),
				JSON.stringify({
					version: 1,
					injectedFiles: [],
					template: "test",
					createdAt: new Date().toISOString(),
				}),
			)
			await addAndCommit(tempDir, "agency.json", "Add agency.json")

			// Feature commit
			await Bun.write(join(tempDir, "feature.txt"), "feature\n")
			await addAndCommit(tempDir, "feature.txt", "Add feature")

			// Last commit is AGENCY_REMOVE_COMMIT
			await Bun.write(join(tempDir, "EXISTING.md"), "Modified content\n")
			await addAndCommit(
				tempDir,
				"EXISTING.md",
				"chore: edit EXISTING\n\nAGENCY_REMOVE_COMMIT",
			)

			await runTestEffect(emit({ silent: true, baseBranch: "main" }))
			await checkoutBranch(tempDir, "last-commit-test")

			// File should be reverted to original
			const content = await Bun.file(join(tempDir, "EXISTING.md")).text()
			expect(content).toBe("Original content\n")

			// Feature commit should exist
			const files = await getGitOutput(tempDir, ["ls-files"])
			expect(files).toContain("feature.txt")
		})

		test("handles AGENCY_REMOVE_COMMIT as only commit (besides agency.json)", async () => {
			if (!hasGitFilterRepo) {
				console.log("Skipping test: git-filter-repo not installed")
				return
			}

			await checkoutBranch(tempDir, "main")

			await Bun.write(join(tempDir, "EXISTING.md"), "Original content\n")
			await addAndCommit(tempDir, "EXISTING.md", "Add existing file")

			await createBranch(tempDir, "agency--only-commit-test")

			// agency.json
			await Bun.write(
				join(tempDir, "agency.json"),
				JSON.stringify({
					version: 1,
					injectedFiles: [],
					template: "test",
					createdAt: new Date().toISOString(),
				}),
			)
			await addAndCommit(tempDir, "agency.json", "Add agency.json")

			// Only other commit is AGENCY_REMOVE_COMMIT
			await Bun.write(join(tempDir, "EXISTING.md"), "Modified content\n")
			await addAndCommit(
				tempDir,
				"EXISTING.md",
				"chore: edit EXISTING\n\nAGENCY_REMOVE_COMMIT",
			)

			await runTestEffect(emit({ silent: true, baseBranch: "main" }))
			await checkoutBranch(tempDir, "only-commit-test")

			// File should be reverted to original
			const content = await Bun.file(join(tempDir, "EXISTING.md")).text()
			expect(content).toBe("Original content\n")

			// Emit branch should exist and have the file
			const files = await getGitOutput(tempDir, ["ls-files"])
			expect(files).toContain("EXISTING.md")
		})
	})
})
