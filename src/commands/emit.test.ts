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
	createBranch,
	addAndCommit,
	setupRemote,
	runTestEffect,
	runTestEffectWithMockFilterRepo,
	clearCapturedFilterRepoCalls,
	getLastCapturedFilterRepoCall,
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

describe("emit command", () => {
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

		// Create a source branch (with agency/ prefix)
		await createBranch(tempDir, "agency/test-feature")

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

	describe("basic functionality", () => {
		test("throws error when git-filter-repo is not installed", async () => {
			const hasGitFilterRepo = await checkGitFilterRepo()
			if (hasGitFilterRepo) {
				// Skip this test if git-filter-repo IS installed
				return
			}

			await createBranch(tempDir, "agency/feature")
			await createCommit(tempDir, "Feature commit")

			expect(runTestEffect(emit({ silent: true }))).rejects.toThrow(
				"git-filter-repo is not installed",
			)
		})

		test("creates emit branch with default name", async () => {
			// Go back to main and create a fresh source branch (no inherited agency.json)
			await checkoutBranch(tempDir, "main")
			await createBranch(tempDir, "agency/feature")
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
			await addAndCommit(tempDir, "agency.json", "Feature commit")

			// Create emit branch (skip filter for speed)
			await runTestEffect(emit({ silent: true, skipFilter: true }))

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
			await createBranch(tempDir, "agency/feature")
			await createCommit(tempDir, "Feature commit")

			// Skip filter for speed - we're just testing branch creation
			await runTestEffect(
				emit({ emit: "custom-pr", silent: true, skipFilter: true }),
			)

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

		test("completes emit workflow successfully", async () => {
			await createBranch(tempDir, "agency/feature")
			await createCommit(tempDir, "Feature commit")

			// Should complete without throwing (skip filter for speed)
			await runTestEffect(emit({ silent: true, skipFilter: true }))

			// Should still be on source branch
			const currentBranch = await getCurrentBranch(tempDir)
			expect(currentBranch).toBe("agency/feature")
		})

		test("preserves files on source branch after emit", async () => {
			await createBranch(tempDir, "agency/feature")
			await createCommit(tempDir, "Feature commit")

			// Skip filter for speed - we're testing source branch preservation
			await runTestEffect(emit({ silent: true, skipFilter: true }))

			// Should still be on source branch
			const currentBranch = await getCurrentBranch(tempDir)
			expect(currentBranch).toBe("agency/feature")

			// Check that test file still exists on source branch
			expect(await fileExists(join(tempDir, "test.txt"))).toBe(true)

			const files = await getGitOutput(tempDir, ["ls-files"])
			expect(files).toContain("test.txt")
		})

		test("original branch remains untouched", async () => {
			await createBranch(tempDir, "agency/feature")
			await createCommit(tempDir, "Feature commit")

			// Create emit branch (skip filter for speed)
			await runTestEffect(emit({ silent: true, skipFilter: true }))

			// Should still be on feature branch
			const currentBranch = await getCurrentBranch(tempDir)
			expect(currentBranch).toBe("agency/feature")

			// Check that AGENTS.md still exist on original branch
			const files = await getGitOutput(tempDir, ["ls-files"])
			expect(files).toContain("AGENTS.md")
		})

		test("works correctly when run multiple times (recreates emit branch)", async () => {
			await createBranch(tempDir, "agency/feature")

			// Modify AGENTS.md on feature branch
			await Bun.write(
				join(tempDir, "AGENTS.md"),
				"# Modified by feature branch\n",
			)
			await addAndCommit(tempDir, "AGENTS.md", "Modify AGENTS.md")

			// Run emit command first time (skip filter for speed)
			await runTestEffect(emit({ silent: true, skipFilter: true }))

			// Switch back to feature branch
			await checkoutBranch(tempDir, "agency/feature")

			// Make another commit
			await createCommit(tempDir, "Another feature commit")

			// Run emit command second time (skip filter for speed)
			await runTestEffect(emit({ silent: true, skipFilter: true }))

			// Should complete successfully without interactive prompts and stay on source branch
			const currentBranch = await getCurrentBranch(tempDir)
			expect(currentBranch).toBe("agency/feature")
		})

		test("accepts explicit base branch argument", async () => {
			await createBranch(tempDir, "agency/feature")
			await createCommit(tempDir, "Feature commit")

			// Create emit branch with explicit base branch (skip filter for speed)
			await runTestEffect(
				emit({ baseBranch: "main", silent: true, skipFilter: true }),
			)

			// Should stay on source branch
			const currentBranch = await getCurrentBranch(tempDir)
			expect(currentBranch).toBe("agency/feature")
		})

		test("throws error if provided base branch does not exist", async () => {
			await createBranch(tempDir, "agency/feature")
			await createCommit(tempDir, "Feature commit")

			// This should fail even with skipFilter since base branch validation happens first
			expect(
				runTestEffect(
					emit({ baseBranch: "nonexistent", silent: true, skipFilter: true }),
				),
			).rejects.toThrow("does not exist")
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
			await createBranch(tempDir, "agency/feature")
			await createCommit(tempDir, "Feature commit")

			const logs: string[] = []
			const originalLog = console.log
			console.log = (...args: any[]) => logs.push(args.join(" "))

			// Skip filter for speed
			await runTestEffect(emit({ silent: true, skipFilter: true }))

			console.log = originalLog

			expect(logs.length).toBe(0)
		})
	})

	describe("filter-repo command construction (with mock)", () => {
		beforeEach(() => {
			clearCapturedFilterRepoCalls()
		})

		test("constructs correct filter-repo arguments", async () => {
			// Set up fresh branch with agency.json
			await checkoutBranch(tempDir, "main")
			await createBranch(tempDir, "agency/filter-test")

			// Create agency.json with injected files
			await Bun.write(
				join(tempDir, "agency.json"),
				JSON.stringify({
					version: 1,
					injectedFiles: ["AGENTS.md"],
					template: "test",
					createdAt: new Date().toISOString(),
				}),
			)
			await addAndCommit(tempDir, "agency.json", "Add agency.json")

			// Run emit with mock filter-repo (not skipFilter!)
			await runTestEffectWithMockFilterRepo(emit({ silent: true }))

			// Verify filter-repo was called with correct arguments
			const lastCall = getLastCapturedFilterRepoCall()
			expect(lastCall).toBeDefined()

			// Should include paths for base files (TASK.md, AGENCY.md, CLAUDE.md, agency.json)
			// and injected files (AGENTS.md)
			expect(lastCall!.args).toContain("--path")
			expect(lastCall!.args).toContain("TASK.md")
			expect(lastCall!.args).toContain("AGENCY.md")
			expect(lastCall!.args).toContain("CLAUDE.md")
			expect(lastCall!.args).toContain("agency.json")
			expect(lastCall!.args).toContain("AGENTS.md")

			// Should include invert-paths and force flags
			expect(lastCall!.args).toContain("--invert-paths")
			expect(lastCall!.args).toContain("--force")

			// Should include refs for the commit range
			expect(lastCall!.args).toContain("--refs")

			// Should have GIT_CONFIG_GLOBAL env set
			expect(lastCall!.env?.GIT_CONFIG_GLOBAL).toBe("")
		})
	})
})
