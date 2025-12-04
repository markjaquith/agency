import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { join } from "path"
import { emit } from "../commands/emit"
import { task } from "../commands/task"
import {
	createTempDir,
	cleanupTempDir,
	initGitRepo,
	initAgency,
	fileExists,
	getGitOutput,
	getCurrentBranch,
	createCommit,
	checkoutBranch,
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

describe("emit command", () => {
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

		// Create a source branch (with agency/ prefix)
		await Bun.spawn(["git", "checkout", "-b", "agency/test-feature"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited

		// Initialize AGENTS.md and commit in one go
		await initAgency(tempDir, "test")

		await runTestEffect(task({ silent: true }))
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

		// Set up origin/main for git-filter-repo
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

	describe("basic functionality", () => {
		test("throws error when git-filter-repo is not installed", async () => {
			if (hasGitFilterRepo) {
				// Skip this test if git-filter-repo IS installed
				return
			}

			await Bun.spawn(["git", "checkout", "-b", "agency/feature"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited
			await createCommit(tempDir, "Feature commit")

			expect(runTestEffect(emit({ silent: true }))).rejects.toThrow(
				"git-filter-repo is not installed",
			)
		})

		test("creates emit branch with default name", async () => {
			if (!hasGitFilterRepo) {
				console.log("Skipping test: git-filter-repo not installed")
				return
			}

			// Go back to main and create a fresh source branch (no inherited agency.json)
			await checkoutBranch(tempDir, "main")
			await Bun.spawn(["git", "checkout", "-b", "agency/feature"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited
			// Create agency.json for this branch
			await Bun.write(
				join(tempDir, "agency.json"),
				JSON.stringify({
					version: 1,
					injectedFiles: ["AGENTS.md"],
					template: "test",
					createdAt: new Date().toISOString(),
				}),
			)
			await Bun.spawn(["git", "add", "agency.json"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited
			await createCommit(tempDir, "Feature commit")

			// Create emit branch
			await runTestEffect(emit({ silent: true }))

			// Check that emit branch exists (default pattern is %branch%, so emit is just "feature")
			const branches = await getGitOutput(tempDir, [
				"branch",
				"--list",
				"feature",
			])
			expect(branches.trim()).toContain("feature")

			// Check we're still on the source branch
			const currentBranch = await getCurrentBranch(tempDir)
			expect(currentBranch).toBe("agency/feature")
		})

		test("creates emit branch with custom name", async () => {
			if (!hasGitFilterRepo) {
				console.log("Skipping test: git-filter-repo not installed")
				return
			}

			await Bun.spawn(["git", "checkout", "-b", "agency/feature"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited
			await createCommit(tempDir, "Feature commit")

			await runTestEffect(emit({ branch: "custom-pr", silent: true }))

			const branches = await getGitOutput(tempDir, [
				"branch",
				"--list",
				"custom-pr",
			])
			expect(branches.trim()).toContain("custom-pr")

			// Check we're still on the source branch
			const currentBranch = await getCurrentBranch(tempDir)
			expect(currentBranch).toBe("agency/feature")
		})

		test("runs git-filter-repo successfully", async () => {
			if (!hasGitFilterRepo) {
				console.log("Skipping test: git-filter-repo not installed")
				return
			}

			await Bun.spawn(["git", "checkout", "-b", "agency/feature"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited
			await createCommit(tempDir, "Feature commit")

			// Should complete without throwing
			await runTestEffect(emit({ silent: true }))

			// Should still be on source branch
			const currentBranch = await getCurrentBranch(tempDir)
			expect(currentBranch).toBe("agency/feature")
		})

		test("preserves other files in emit branch", async () => {
			if (!hasGitFilterRepo) {
				console.log("Skipping test: git-filter-repo not installed")
				return
			}

			await Bun.spawn(["git", "checkout", "-b", "agency/feature"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited
			await createCommit(tempDir, "Feature commit")

			await runTestEffect(emit({ silent: true }))

			// Should still be on source branch
			const currentBranch = await getCurrentBranch(tempDir)
			expect(currentBranch).toBe("agency/feature")

			// Switch to emit branch to verify files
			await Bun.spawn(["git", "checkout", "agency/feature"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited

			// Check that test file still exists
			expect(await fileExists(join(tempDir, "test.txt"))).toBe(true)

			const files = await getGitOutput(tempDir, ["ls-files"])
			expect(files).toContain("test.txt")
		})

		test("removes AGENTS.md on emit branch even when not modified on feature branch", async () => {
			if (!hasGitFilterRepo) {
				console.log("Skipping test: git-filter-repo not installed")
				return
			}

			// Go back to main and create a fresh source branch
			await checkoutBranch(tempDir, "main")
			await Bun.spawn(["git", "checkout", "-b", "agency/feature"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited
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
			await Bun.spawn(["git", "add", "agency.json", "AGENTS.md"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited
			await createCommit(tempDir, "Feature commit")

			// Create emit branch
			await runTestEffect(emit({ silent: true }))

			// Should still be on feature branch
			const currentBranch = await getCurrentBranch(tempDir)
			expect(currentBranch).toBe("agency/feature")

			// Switch to emit branch to verify files
			await Bun.spawn(["git", "checkout", "feature"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited

			// AGENCY.md is always filtered on emit branches (it belongs to the tool, not user code)
			const files = await getGitOutput(tempDir, ["ls-files"])
			expect(files).not.toContain("AGENTS.md")
			expect(files).not.toContain("AGENCY.md")

			// But test.txt should still exist
			expect(files).toContain("test.txt")
		})

		test("removes AGENTS.md modifications on emit branch", async () => {
			if (!hasGitFilterRepo) {
				console.log("Skipping test: git-filter-repo not installed")
				return
			}

			// Go back to main and create a fresh source branch
			await checkoutBranch(tempDir, "main")
			await Bun.spawn(["git", "checkout", "-b", "agency/feature"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited

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
			await Bun.spawn(["git", "add", "agency.json"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited

			// Modify AGENTS.md on feature branch
			await Bun.write(
				join(tempDir, "AGENTS.md"),
				"# Modified by feature branch\n",
			)
			await Bun.spawn(["git", "add", "AGENTS.md"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited
			await Bun.spawn(
				["git", "commit", "--no-verify", "-m", "Modify AGENTS.md"],
				{ cwd: tempDir, stdout: "pipe", stderr: "pipe" },
			).exited

			await createCommit(tempDir, "Feature commit")

			// Get the original content from feature branch
			const featureAgentsContent = await Bun.file(
				join(tempDir, "AGENTS.md"),
			).text()
			expect(featureAgentsContent).toContain("Modified by feature branch")

			// Create emit branch
			await runTestEffect(emit({ silent: true }))

			// Should still be on feature branch
			const currentBranch = await getCurrentBranch(tempDir)
			expect(currentBranch).toBe("agency/feature")

			// Switch to emit branch to verify files
			await Bun.spawn(["git", "checkout", "feature"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited

			// AGENCY.md is always filtered on emit branches (it belongs to the tool, not user code)
			const files = await getGitOutput(tempDir, ["ls-files"])
			expect(files).not.toContain("AGENTS.md")
			expect(files).not.toContain("AGENCY.md")
		})

		test("removes AGENTS.md when it was added only on feature branch", async () => {
			if (!hasGitFilterRepo) {
				console.log("Skipping test: git-filter-repo not installed")
				return
			}

			// Start fresh without AGENTS.md on main
			const freshDir = await createTempDir()
			await initGitRepo(freshDir)
			await createCommit(freshDir, "Initial commit")

			// Rename to main
			const currentBranch = await getCurrentBranch(freshDir)
			if (currentBranch === "master") {
				await Bun.spawn(["git", "branch", "-m", "main"], {
					cwd: freshDir,
					stdout: "pipe",
					stderr: "pipe",
				}).exited
			}

			// Set up origin for filter-repo
			await Bun.spawn(["git", "remote", "add", "origin", freshDir], {
				cwd: freshDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited
			await Bun.spawn(["git", "fetch", "origin"], {
				cwd: freshDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited

			// Create feature branch and add AGENTS.md
			await Bun.spawn(["git", "checkout", "-b", "agency/feature"], {
				cwd: freshDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited
			await Bun.write(join(freshDir, "AGENTS.md"), "# Feature only\n")
			// Create agency.json to track that AGENTS.md was injected
			await Bun.write(
				join(freshDir, "agency.json"),
				JSON.stringify(
					{
						version: 1,
						injectedFiles: ["AGENTS.md"],
						template: "test",
						createdAt: new Date().toISOString(),
					},
					null,
					2,
				) + "\n",
			)
			await Bun.spawn(["git", "add", "AGENTS.md", "agency.json"], {
				cwd: freshDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited
			await Bun.spawn(["git", "commit", "--no-verify", "-m", "Add AGENTS.md"], {
				cwd: freshDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited

			// Create emit branch
			process.chdir(freshDir)
			await runTestEffect(emit({ silent: true }))

			// Should still be on feature branch
			let branchName = await getCurrentBranch(freshDir)
			expect(branchName).toBe("agency/feature")

			// Switch to emit branch to verify files
			await Bun.spawn(["git", "checkout", "feature"], {
				cwd: freshDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited

			// AGENTS.md should NOT exist (it was removed)
			const files = await getGitOutput(freshDir, ["ls-files"])
			expect(files).not.toContain("AGENTS.md")

			await cleanupTempDir(freshDir)
		})

		test("original branch remains untouched", async () => {
			if (!hasGitFilterRepo) {
				console.log("Skipping test: git-filter-repo not installed")
				return
			}

			await Bun.spawn(["git", "checkout", "-b", "agency/feature"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited
			await createCommit(tempDir, "Feature commit")

			// Create emit branch
			await runTestEffect(emit({ silent: true }))

			// Should still be on feature branch
			const currentBranch = await getCurrentBranch(tempDir)
			expect(currentBranch).toBe("agency/feature")

			// Check that AGENTS.md still exist on original branch
			const files = await getGitOutput(tempDir, ["ls-files"])
			expect(files).toContain("AGENTS.md")
		})

		test("works correctly when run multiple times (cleans up filter-repo state)", async () => {
			if (!hasGitFilterRepo) {
				console.log("Skipping test: git-filter-repo not installed")
				return
			}

			await Bun.spawn(["git", "checkout", "-b", "agency/feature"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited

			// Modify AGENTS.md on feature branch
			await Bun.write(
				join(tempDir, "AGENTS.md"),
				"# Modified by feature branch\n",
			)
			await Bun.spawn(["git", "add", "AGENTS.md"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited
			await Bun.spawn(
				["git", "commit", "--no-verify", "-m", "Modify AGENTS.md"],
				{ cwd: tempDir, stdout: "pipe", stderr: "pipe" },
			).exited

			// Run emit command first time
			await runTestEffect(emit({ silent: true }))

			// Switch back to feature branch
			await Bun.spawn(["git", "checkout", "agency/feature"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited

			// Make another commit
			await createCommit(tempDir, "Another feature commit")

			// Run emit command second time - this would trigger the "already_ran" prompt
			// without the cleanup code
			await runTestEffect(emit({ silent: true }))

			// Should complete successfully without interactive prompts and stay on source branch
			const currentBranch = await getCurrentBranch(tempDir)
			expect(currentBranch).toBe("agency/feature")
		})

		test("accepts explicit base branch argument", async () => {
			if (!hasGitFilterRepo) {
				console.log("Skipping test: git-filter-repo not installed")
				return
			}

			await Bun.spawn(["git", "checkout", "-b", "agency/feature"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited
			await createCommit(tempDir, "Feature commit")

			// Create emit branch with explicit base branch
			await runTestEffect(emit({ baseBranch: "main", silent: true }))

			// Should stay on source branch
			const currentBranch = await getCurrentBranch(tempDir)
			expect(currentBranch).toBe("agency/feature")
		})

		test("throws error if provided base branch does not exist", async () => {
			if (!hasGitFilterRepo) {
				console.log("Skipping test: git-filter-repo not installed")
				return
			}

			await Bun.spawn(["git", "checkout", "-b", "agency/feature"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited
			await createCommit(tempDir, "Feature commit")

			expect(
				runTestEffect(emit({ baseBranch: "nonexistent", silent: true })),
			).rejects.toThrow("does not exist")
		})

		test("handles emit branch recreation after source branch rebase", async () => {
			if (!hasGitFilterRepo) {
				console.log("Skipping test: git-filter-repo not installed")
				return
			}

			// We're on test-feature which has AGENTS.md
			// Add a feature-specific file to avoid conflicts
			await Bun.write(join(tempDir, "feature.txt"), "feature content\n")
			await Bun.spawn(["git", "add", "feature.txt"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited
			await Bun.spawn(
				["git", "commit", "--no-verify", "-m", "Add feature file"],
				{ cwd: tempDir, stdout: "pipe", stderr: "pipe" },
			).exited

			// Store merge-base before advancing main
			const initialMergeBase = await getGitOutput(tempDir, [
				"merge-base",
				"agency/test-feature",
				"main",
			])

			// Create initial emit branch
			await runTestEffect(emit({ silent: true, baseBranch: "main" }))

			// Should still be on test-feature branch
			let currentBranch = await getCurrentBranch(tempDir)
			expect(currentBranch).toBe("agency/test-feature")

			// Switch to emit branch to verify AGENTS.md is filtered
			await Bun.spawn(["git", "checkout", "test-feature"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited

			let files = await getGitOutput(tempDir, ["ls-files"])
			expect(files).not.toContain("AGENTS.md")
			expect(files).toContain("feature.txt")

			// Switch back to source branch
			await Bun.spawn(["git", "checkout", "agency/test-feature"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited

			// Simulate advancing main branch with a different file
			await Bun.spawn(["git", "checkout", "main"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited
			await Bun.write(join(tempDir, "main-file.txt"), "main content\n")
			await Bun.spawn(["git", "add", "main-file.txt"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited
			await Bun.spawn(
				["git", "commit", "--no-verify", "-m", "Main branch advancement"],
				{ cwd: tempDir, stdout: "pipe", stderr: "pipe" },
			).exited

			// Rebase test-feature onto new main
			await Bun.spawn(["git", "checkout", "agency/test-feature"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited
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
				"agency/test-feature",
				"main",
			])
			expect(newMergeBase.trim()).not.toBe(initialMergeBase.trim())

			// Recreate emit branch after rebase (this is where the bug would manifest)
			await runTestEffect(emit({ silent: true, baseBranch: "main" }))

			// Should still be on test-feature branch
			currentBranch = await getCurrentBranch(tempDir)
			expect(currentBranch).toBe("agency/test-feature")

			// Switch to emit branch to verify files
			await Bun.spawn(["git", "checkout", "test-feature"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited

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
	})

	describe("error handling", () => {
		test("throws error when not in a git repository", async () => {
			const nonGitDir = await createTempDir()
			process.chdir(nonGitDir)

			expect(runTestEffect(emit({ silent: true }))).rejects.toThrow(
				"Not in a git repository",
			)

			await cleanupTempDir(nonGitDir)
		})
	})

	describe("silent mode", () => {
		test("silent flag suppresses output", async () => {
			if (!hasGitFilterRepo) {
				console.log("Skipping test: git-filter-repo not installed")
				return
			}

			await Bun.spawn(["git", "checkout", "-b", "agency/feature"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited
			await createCommit(tempDir, "Feature commit")

			const logs: string[] = []
			const originalLog = console.log
			console.log = (...args: any[]) => logs.push(args.join(" "))

			await runTestEffect(emit({ silent: true }))

			console.log = originalLog

			expect(logs.length).toBe(0)
		})
	})
})
