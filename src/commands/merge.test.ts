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
	checkoutBranch,
	createBranch,
	addAndCommit,
	setupRemote,
	deleteBranch,
	runTestEffect,
} from "../test-utils"

describe("merge command", () => {
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

		// Initialize git repo with main branch (already includes initial commit)
		await initGitRepo(tempDir)

		// Set up origin for git-filter-repo
		await setupRemote(tempDir, "origin", tempDir)

		// Create a source branch (with agency-- prefix per new default config)
		await createBranch(tempDir, "agency--feature")

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
			// Create emit branch (skipFilter for speed since we're testing error handling)
			await runTestEffect(emit({ silent: true, skipFilter: true }))

			// Delete main branch (the base)
			await checkoutBranch(tempDir, "feature")
			await deleteBranch(tempDir, "main", true)

			// Try to merge - should fail
			await expect(
				runTestEffect(merge({ silent: true, skipFilter: true })),
			).rejects.toThrow("does not exist locally")
		})
	})

	describe("silent mode", () => {
		test("silent flag suppresses output", async () => {
			const logs: string[] = []
			const originalLog = console.log
			console.log = (...args: any[]) => logs.push(args.join(" "))

			await runTestEffect(merge({ silent: true, skipFilter: true }))

			console.log = originalLog

			expect(logs.length).toBe(0)
		})
	})

	describe("squash merge", () => {
		test("performs squash merge when --squash flag is set", async () => {
			// We're on feature branch (source)
			const currentBranch = await getCurrentBranch(tempDir)
			expect(currentBranch).toBe("agency--feature")

			// Run merge with squash flag (skipFilter for speed, we're testing squash behavior)
			await runTestEffect(
				merge({ silent: true, squash: true, skipFilter: true }),
			)

			// Should be on main branch after merge
			const afterMergeBranch = await getCurrentBranch(tempDir)
			expect(afterMergeBranch).toBe("main")

			// Check that changes are staged but not committed
			const status = await getGitOutput(tempDir, ["status", "--porcelain"])

			// Staged changes should be present (indicated by status codes in first column)
			expect(status.trim().length).toBeGreaterThan(0)

			// Get the log to verify no merge commit was created
			const log = await getGitOutput(tempDir, ["log", "--oneline", "-5"])

			// Should not contain a merge commit message
			expect(log).not.toContain("Merge branch")
		})

		test("performs regular merge when --squash flag is not set", async () => {
			// We're on feature branch (source)
			const currentBranch = await getCurrentBranch(tempDir)
			expect(currentBranch).toBe("agency--feature")

			// Run merge without squash flag (skipFilter for speed, we're testing merge behavior)
			await runTestEffect(
				merge({ silent: true, squash: false, skipFilter: true }),
			)

			// Should be on main branch after merge
			const afterMergeBranch = await getCurrentBranch(tempDir)
			expect(afterMergeBranch).toBe("main")

			// With regular merge (not squash), there should be no staged changes
			const status = await getGitOutput(tempDir, ["status", "--porcelain"])

			// No staged changes - everything should be committed
			expect(status.trim().length).toBe(0)

			// Get the log to verify commits were included
			const log = await getGitOutput(tempDir, ["log", "--oneline", "-5"])

			// Should contain the feature work commit (regular merge includes all commits)
			expect(log).toContain("Feature work")
		})
	})

	describe("push flag", () => {
		test("pushes base branch to origin when --push flag is set", async () => {
			// We're on feature branch (source)
			const currentBranch = await getCurrentBranch(tempDir)
			expect(currentBranch).toBe("agency--feature")

			// Get the current commit on main before merge
			await checkoutBranch(tempDir, "main")
			const beforeCommit = (
				await getGitOutput(tempDir, ["rev-parse", "HEAD"])
			).trim()

			// Go back to feature branch
			await checkoutBranch(tempDir, "agency--feature")

			// Run merge with push flag (skipFilter for speed, we're testing push behavior)
			await runTestEffect(merge({ silent: true, push: true, skipFilter: true }))

			// Should be on main branch after merge
			const afterMergeBranch = await getCurrentBranch(tempDir)
			expect(afterMergeBranch).toBe("main")

			// Get the current commit on main after merge
			const afterCommit = (
				await getGitOutput(tempDir, ["rev-parse", "HEAD"])
			).trim()

			// The commit should have changed (merge happened)
			expect(afterCommit).not.toBe(beforeCommit)

			// Verify that origin/main points to the same commit as local main
			const originMainCommit = (
				await getGitOutput(tempDir, ["rev-parse", "origin/main"])
			).trim()

			// origin/main should be at the same commit as local main (push succeeded)
			expect(originMainCommit).toBe(afterCommit)
		})

		test("does not push when --push flag is not set", async () => {
			// We're on feature branch (source)
			const currentBranch = await getCurrentBranch(tempDir)
			expect(currentBranch).toBe("agency--feature")

			// Get the current commit on origin/main before merge
			const beforeOriginCommit = (
				await getGitOutput(tempDir, ["rev-parse", "origin/main"])
			).trim()

			// Run merge without push flag (skipFilter for speed, we're testing push behavior)
			await runTestEffect(merge({ silent: true, skipFilter: true }))

			// Should be on main branch after merge
			const afterMergeBranch = await getCurrentBranch(tempDir)
			expect(afterMergeBranch).toBe("main")

			// Get the current commit on origin/main after merge
			const afterOriginCommit = (
				await getGitOutput(tempDir, ["rev-parse", "origin/main"])
			).trim()

			// origin/main should still be at the same commit (no push happened)
			expect(afterOriginCommit).toBe(beforeOriginCommit)

			// But local main should have moved forward
			const localMainCommit = (
				await getGitOutput(tempDir, ["rev-parse", "HEAD"])
			).trim()

			expect(localMainCommit).not.toBe(beforeOriginCommit)
		})
	})
})
