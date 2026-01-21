import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { join } from "path"
import { merge } from "./merge"
import { emit } from "./emit"
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
	checkoutBranch,
	createBranch,
	addAndCommit,
	setupRemote,
	deleteBranch,
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

describe("merge command - integration tests (requires git-filter-repo)", () => {
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
		await setupRemote(tempDir, "origin", tempDir)

		// Create a source branch (with agency/ prefix per new default config)
		await createBranch(tempDir, "agency/feature")

		// Initialize AGENTS.md on feature branch
		await initAgency(tempDir, "test")

		await runTestEffect(task({ silent: true, fromCurrent: true }))

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

		await addAndCommit(tempDir, "AGENTS.md agency.json", "Add AGENTS.md")

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
		test("creates emit branch and merges when run from source branch", async () => {
			if (!hasGitFilterRepo) {
				console.log("Skipping test: git-filter-repo not installed")
				return
			}

			// We're on feature branch (source)
			const currentBranch = await getCurrentBranch(tempDir)
			expect(currentBranch).toBe("agency/feature")

			// Run merge - should create feature--PR and merge it to main
			await runTestEffect(merge({ silent: true }))

			// Should be on main branch after merge
			const afterMergeBranch = await getCurrentBranch(tempDir)
			expect(afterMergeBranch).toBe("main")

			// emit branch should exist
			const prExists = await branchExists(tempDir, "feature")
			expect(prExists).toBe(true)

			// Main should have the feature work but not AGENTS.md
			const files = await getGitOutput(tempDir, ["ls-files"])
			expect(files).not.toContain("AGENTS.md")
		})

		test("recreates emit branch if it already exists", async () => {
			if (!hasGitFilterRepo) {
				console.log("Skipping test: git-filter-repo not installed")
				return
			}

			// Create emit branch first
			await runTestEffect(emit({ silent: true }))

			// Go back to feature branch
			await checkoutBranch(tempDir, "agency/feature")

			// Make additional changes
			await createCommit(tempDir, "More feature work")

			// Run merge - should recreate emit branch with new changes
			await runTestEffect(merge({ silent: true }))

			// Should be on main after merge
			const currentBranch = await getCurrentBranch(tempDir)
			expect(currentBranch).toBe("main")
		})
	})

	describe("merge from emit branch", () => {
		test("merges emit branch directly when run from emit branch", async () => {
			if (!hasGitFilterRepo) {
				console.log("Skipping test: git-filter-repo not installed")
				return
			}

			// Create emit branch
			await runTestEffect(emit({ silent: true }))

			// emit() now stays on source branch, so we need to checkout to emit branch
			await checkoutBranch(tempDir, "feature")

			// We're on feature--PR now
			const currentBranch = await getCurrentBranch(tempDir)
			expect(currentBranch).toBe("feature")

			// Run merge - should merge feature--PR to main
			await runTestEffect(merge({ silent: true }))

			// Should be on main after merge
			const afterMergeBranch = await getCurrentBranch(tempDir)
			expect(afterMergeBranch).toBe("main")

			// Main should have the feature work but not AGENTS.md
			const files = await getGitOutput(tempDir, ["ls-files"])
			expect(files).not.toContain("AGENTS.md")
		})

		test("throws error if emit branch has no corresponding source branch", async () => {
			if (!hasGitFilterRepo) {
				console.log("Skipping test: git-filter-repo not installed")
				return
			}

			// Create emit branch
			await runTestEffect(emit({ silent: true }))

			// pr() now stays on source branch, so checkout to emit branch
			await checkoutBranch(tempDir, "feature")

			// Delete the source branch
			await deleteBranch(tempDir, "agency/feature", true)

			// Try to merge - should fail (error message may vary since source branch is deleted)
			await expect(runTestEffect(merge({ silent: true }))).rejects.toThrow()
		})
	})
})
