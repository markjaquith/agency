import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { join } from "path"
import { clean } from "./clean"
import {
	createTempDir,
	cleanupTempDir,
	initGitRepo,
	initAgency,
	getGitOutput,
	getCurrentBranch,
	createCommit,
	checkoutBranch,
	runTestEffect,
} from "../test-utils"

describe("clean command", () => {
	let tempDir: string
	let originalCwd: string

	beforeEach(async () => {
		tempDir = await createTempDir()
		originalCwd = process.cwd()
		process.chdir(tempDir)

		// Set config path to non-existent file to use defaults
		process.env.AGENCY_CONFIG_PATH = join(tempDir, "non-existent-config.json")
		// Set config dir to temp dir to avoid picking up user's config files
		process.env.AGENCY_CONFIG_DIR = await createTempDir()

		// Initialize git repo with main branch
		await initGitRepo(tempDir)

		// Initialize agency in main branch
		await initAgency(tempDir, "test")
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

	describe("--merged-into flag requirement", () => {
		test("throws error when --merged-into flag is not provided", async () => {
			expect(runTestEffect(clean({ silent: true }))).rejects.toThrow(
				"--merged-into flag is required",
			)
		})

		test("throws error when specified branch does not exist", async () => {
			expect(
				runTestEffect(clean({ mergedInto: "nonexistent", silent: true })),
			).rejects.toThrow("does not exist")
		})
	})

	describe("basic functionality", () => {
		test("finds and deletes branches merged into target", async () => {
			// Create feature branch, make commits, and merge to main
			await checkoutBranch(tempDir, "main")
			await Bun.spawn(["git", "checkout", "-b", "feature-1"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited
			await createCommit(tempDir, "Feature 1 commit")
			await checkoutBranch(tempDir, "main")
			await Bun.spawn(["git", "merge", "--no-ff", "feature-1"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited

			// Run clean command
			await runTestEffect(clean({ mergedInto: "main", silent: true }))

			// Verify feature-1 was deleted
			const branches = await getGitOutput(tempDir, ["branch", "--list"])
			expect(branches).not.toContain("feature-1")
			expect(branches).toContain("main")
		})

		test("finds source branches for merged emit branches", async () => {
			// Create source branch with agency pattern
			await checkoutBranch(tempDir, "main")
			await Bun.spawn(["git", "checkout", "-b", "agency--feature-2"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited

			// Create agency.json with emitBranch
			await Bun.write(
				join(tempDir, "agency.json"),
				JSON.stringify({
					version: 1,
					injectedFiles: ["AGENTS.md"],
					template: "test",
					emitBranch: "feature-2",
					createdAt: new Date().toISOString(),
				}),
			)
			await Bun.spawn(["git", "add", "agency.json"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited
			await createCommit(tempDir, "Feature 2 commit")

			// Create the emit branch manually
			await Bun.spawn(["git", "checkout", "-b", "feature-2"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited

			// Merge emit branch to main
			await checkoutBranch(tempDir, "main")
			await Bun.spawn(["git", "merge", "--no-ff", "feature-2"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited

			// Run clean command
			await runTestEffect(clean({ mergedInto: "main", silent: true }))

			// Verify both emit and source branches were deleted
			const branches = await getGitOutput(tempDir, ["branch", "--list"])
			expect(branches).not.toContain("feature-2")
			expect(branches).not.toContain("agency--feature-2")
			expect(branches).toContain("main")
		})

		test("does not delete unmerged branches", async () => {
			// Create an unmerged feature branch
			await checkoutBranch(tempDir, "main")
			await Bun.spawn(["git", "checkout", "-b", "feature-unmerged"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited
			await createCommit(tempDir, "Unmerged commit")

			// Run clean command
			await checkoutBranch(tempDir, "main")
			await runTestEffect(clean({ mergedInto: "main", silent: true }))

			// Verify unmerged branch still exists
			const branches = await getGitOutput(tempDir, ["branch", "--list"])
			expect(branches).toContain("feature-unmerged")
		})

		test("does not delete the target branch itself", async () => {
			// Run clean on main (nothing should happen)
			await checkoutBranch(tempDir, "main")
			await runTestEffect(clean({ mergedInto: "main", silent: true }))

			// Verify main still exists
			const branches = await getGitOutput(tempDir, ["branch", "--list"])
			expect(branches).toContain("main")
		})
	})

	describe("dry-run mode", () => {
		test("shows branches without deleting in dry-run mode", async () => {
			// Create and merge feature branch
			await checkoutBranch(tempDir, "main")
			await Bun.spawn(["git", "checkout", "-b", "feature-dry"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited
			await createCommit(tempDir, "Feature dry commit")
			await checkoutBranch(tempDir, "main")
			await Bun.spawn(["git", "merge", "--no-ff", "feature-dry"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited

			// Run clean in dry-run mode
			await runTestEffect(
				clean({ mergedInto: "main", dryRun: true, silent: true }),
			)

			// Verify branch still exists
			const branches = await getGitOutput(tempDir, ["branch", "--list"])
			expect(branches).toContain("feature-dry")
		})
	})

	describe("branch switching", () => {
		test("switches away from branch being deleted if currently on it", async () => {
			// Create and merge feature branch
			await checkoutBranch(tempDir, "main")
			await Bun.spawn(["git", "checkout", "-b", "feature-switch"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited
			await createCommit(tempDir, "Feature switch commit")
			await checkoutBranch(tempDir, "main")
			await Bun.spawn(["git", "merge", "--no-ff", "feature-switch"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited

			// Checkout the branch that will be deleted
			await checkoutBranch(tempDir, "feature-switch")

			// Run clean command
			await runTestEffect(clean({ mergedInto: "main", silent: true }))

			// Verify we're now on main
			const currentBranch = await getCurrentBranch(tempDir)
			expect(currentBranch).toBe("main")

			// Verify branch was deleted
			const branches = await getGitOutput(tempDir, ["branch", "--list"])
			expect(branches).not.toContain("feature-switch")
		})
	})

	describe("multiple branches", () => {
		test("deletes multiple merged branches at once", async () => {
			await checkoutBranch(tempDir, "main")

			// Create and merge feature-1
			await Bun.spawn(["git", "checkout", "-b", "feature-1"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited
			await createCommit(tempDir, "Feature 1 commit")
			await checkoutBranch(tempDir, "main")
			await Bun.spawn(["git", "merge", "--no-ff", "feature-1"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited

			// Create and merge feature-2
			await Bun.spawn(["git", "checkout", "-b", "feature-2"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited
			await createCommit(tempDir, "Feature 2 commit")
			await checkoutBranch(tempDir, "main")
			await Bun.spawn(["git", "merge", "--no-ff", "feature-2"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited

			// Run clean command
			await runTestEffect(clean({ mergedInto: "main", silent: true }))

			// Verify both branches were deleted
			const branches = await getGitOutput(tempDir, ["branch", "--list"])
			expect(branches).not.toContain("feature-1")
			expect(branches).not.toContain("feature-2")
			expect(branches).toContain("main")
		})
	})

	describe("no merged branches", () => {
		test("handles case with no merged branches gracefully", async () => {
			// Don't create any feature branches, just run clean
			await checkoutBranch(tempDir, "main")

			// Should not throw
			await runTestEffect(clean({ mergedInto: "main", silent: true }))

			// Main should still exist
			const branches = await getGitOutput(tempDir, ["branch", "--list"])
			expect(branches).toContain("main")
		})
	})

	describe("error handling", () => {
		test("throws error when not in a git repository", async () => {
			const nonGitDir = await createTempDir()
			process.chdir(nonGitDir)

			expect(
				runTestEffect(clean({ mergedInto: "main", silent: true })),
			).rejects.toThrow("Not in a git repository")

			await cleanupTempDir(nonGitDir)
		})
	})
})
