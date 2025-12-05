import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { join } from "path"
import { push } from "./push"
import {
	createTempDir,
	cleanupTempDir,
	initGitRepo,
	getCurrentBranch,
	createCommit,
	checkoutBranch,
	runTestEffect,
} from "../test-utils"

async function createBranch(cwd: string, branchName: string): Promise<void> {
	await Bun.spawn(["git", "checkout", "-b", branchName], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	}).exited
}

async function setupAgencyJson(gitRoot: string): Promise<void> {
	const agencyJson = {
		version: 1,
		injectedFiles: ["AGENTS.MD", "TASK.md"],
		template: "test",
		createdAt: new Date().toISOString(),
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
	await createCommit(gitRoot, "Add agency.json")
}

async function setupBareRemote(tempDir: string): Promise<string> {
	// Create a bare repository to use as remote
	const remoteDir = join(tempDir, "remote.git")
	await Bun.spawn(["git", "init", "--bare", remoteDir], {
		stdout: "pipe",
		stderr: "pipe",
	}).exited

	return remoteDir
}

async function addRemote(cwd: string, remoteUrl: string): Promise<void> {
	await Bun.spawn(["git", "remote", "add", "origin", remoteUrl], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	}).exited
}

describe("push command", () => {
	let tempDir: string
	let remoteDir: string
	let originalCwd: string

	beforeEach(async () => {
		tempDir = await createTempDir()
		originalCwd = process.cwd()
		process.chdir(tempDir)

		// Set config path to non-existent file to use defaults
		process.env.AGENCY_CONFIG_PATH = join(tempDir, "non-existent-config.json")

		// Initialize git repo
		await initGitRepo(tempDir)
		await createCommit(tempDir, "Initial commit")

		// Rename to main if needed
		const currentBranch = await getCurrentBranch(tempDir)
		if (currentBranch === "master") {
			await Bun.spawn(["git", "branch", "-m", "main"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited
		}

		// Setup bare remote
		remoteDir = await setupBareRemote(tempDir)
		await addRemote(tempDir, remoteDir)

		// Push main to remote
		await Bun.spawn(["git", "push", "-u", "origin", "main"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited

		// Setup agency.json
		await setupAgencyJson(tempDir)

		// Create a source branch (with agency/ prefix per new default config)
		await createBranch(tempDir, "agency/feature")
		await createCommit(tempDir, "Feature work")
	})

	afterEach(async () => {
		process.chdir(originalCwd)
		delete process.env.AGENCY_CONFIG_PATH
		await cleanupTempDir(tempDir)
	})

	describe("basic functionality", () => {
		test("creates emit branch, pushes it, and returns to source", async () => {
			// We're on agency/feature branch (source)
			expect(await getCurrentBranch(tempDir)).toBe("agency/feature")

			// Run push command
			await runTestEffect(push({ baseBranch: "main", silent: true }))

			// Should be back on agency/feature branch (source)
			expect(await getCurrentBranch(tempDir)).toBe("agency/feature")

			// emit branch (feature) should exist locally
			const branchesProc = Bun.spawn(["git", "branch"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			})
			await branchesProc.exited
			const branches = await new Response(branchesProc.stdout).text()
			expect(branches).toContain("feature")

			// emit branch (feature) should exist on remote
			const remoteBranchesProc = Bun.spawn(
				["git", "ls-remote", "--heads", "origin", "feature"],
				{
					cwd: tempDir,
					stdout: "pipe",
					stderr: "pipe",
				},
			)
			await remoteBranchesProc.exited
			const remoteBranches = await new Response(
				remoteBranchesProc.stdout,
			).text()
			expect(remoteBranches).toContain("feature")
		})

		test("works with custom branch name", async () => {
			await runTestEffect(
				push({
					baseBranch: "main",
					branch: "custom-pr-branch",
					silent: true,
				}),
			)

			// Should be back on agency/feature branch (source)
			expect(await getCurrentBranch(tempDir)).toBe("agency/feature")

			// Custom branch should exist
			const branchesProc = Bun.spawn(["git", "branch"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			})
			await branchesProc.exited
			const branches = await new Response(branchesProc.stdout).text()
			expect(branches).toContain("custom-pr-branch")
		})

		test("recreates emit branch if it already exists", async () => {
			// First push
			await runTestEffect(push({ baseBranch: "main", silent: true }))

			// Make more changes on source branch
			await checkoutBranch(tempDir, "agency/feature")
			await createCommit(tempDir, "More feature work")

			// Second push should recreate the emit branch
			await runTestEffect(push({ baseBranch: "main", silent: true }))

			// Should still be back on agency/feature branch (source)
			expect(await getCurrentBranch(tempDir)).toBe("agency/feature")
		})
	})

	describe("error handling", () => {
		test("switches to source branch when run from emit branch", async () => {
			// First create the emit branch from source branch
			await runTestEffect(push({ baseBranch: "main", silent: true }))

			// Now we're on agency/feature, switch to the emit branch (feature)
			await checkoutBranch(tempDir, "feature")

			// Verify we're on the emit branch
			expect(await getCurrentBranch(tempDir)).toBe("feature")

			// Make a change on source branch that we'll push
			await checkoutBranch(tempDir, "agency/feature")
			await createCommit(tempDir, "Another feature commit")

			// Switch back to emit branch
			await checkoutBranch(tempDir, "feature")

			// Run push from emit branch - should detect we're on emit branch,
			// switch to source (agency/feature), and continue
			await runTestEffect(push({ baseBranch: "main", silent: true }))

			// Should be back on agency/feature branch (the source branch)
			expect(await getCurrentBranch(tempDir)).toBe("agency/feature")
		})

		test("throws error when not in a git repository", async () => {
			const nonGitDir = await createTempDir()
			process.chdir(nonGitDir)

			await expect(
				runTestEffect(push({ baseBranch: "main", silent: true })),
			).rejects.toThrow("Not in a git repository")

			await cleanupTempDir(nonGitDir)
		})

		test("handles push failure gracefully", async () => {
			// Remove the remote to cause push to fail
			await Bun.spawn(["git", "remote", "remove", "origin"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited

			// Push should fail because no remote exists
			await expect(
				runTestEffect(push({ baseBranch: "main", silent: true })),
			).rejects.toThrow(/No git remotes found/)
		})
	})

	describe("silent mode", () => {
		test("silent flag suppresses output", async () => {
			// Capture output
			const originalLog = console.log
			let logCalled = false
			console.log = () => {
				logCalled = true
			}

			await runTestEffect(push({ baseBranch: "main", silent: true }))

			console.log = originalLog
			expect(logCalled).toBe(false)
		})
	})

	describe("force push", () => {
		test("force pushes when branch has diverged and --force is provided", async () => {
			// First push
			await runTestEffect(push({ baseBranch: "main", silent: true }))

			// Make changes on source branch
			await checkoutBranch(tempDir, "agency/feature")
			await createCommit(tempDir, "More feature work")

			// Modify the emit branch to create divergence
			await checkoutBranch(tempDir, "feature")
			await createCommit(tempDir, "Direct emit branch commit")
			await Bun.spawn(["git", "push"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited

			// Go back to source branch and try to push again with --force
			await checkoutBranch(tempDir, "agency/feature")

			// Capture output to check for force push message
			const originalLog = console.log
			let logMessages: string[] = []
			console.log = (msg: string) => {
				logMessages.push(msg)
			}

			await runTestEffect(
				push({ baseBranch: "main", force: true, silent: false }),
			)

			console.log = originalLog

			// Should be back on agency/feature branch (source)
			expect(await getCurrentBranch(tempDir)).toBe("agency/feature")

			// Should have reported force push
			expect(logMessages.some((msg) => msg.includes("(forced)"))).toBe(true)
		})

		test("suggests using --force when push is rejected without it", async () => {
			// First push
			await runTestEffect(push({ baseBranch: "main", silent: true }))

			// Make changes on source branch
			await checkoutBranch(tempDir, "agency/feature")
			await createCommit(tempDir, "More feature work")

			// Modify the emit branch to create divergence
			await checkoutBranch(tempDir, "feature")
			await createCommit(tempDir, "Direct emit branch commit")
			await Bun.spawn(["git", "push"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited

			// Go back to source branch and try to push without --force
			await checkoutBranch(tempDir, "agency/feature")

			// Should throw error suggesting --force
			await expect(
				runTestEffect(push({ baseBranch: "main", silent: true })),
			).rejects.toThrow(/agency push --force/)

			// Should still be on agency/feature branch (not left in intermediate state)
			expect(await getCurrentBranch(tempDir)).toBe("agency/feature")
		})

		test("does not report force push when --force is provided but not needed", async () => {
			// Capture output to check for force push message
			const originalLog = console.log
			let logMessages: string[] = []
			console.log = (msg: string) => {
				logMessages.push(msg)
			}

			// First push with --force (but it won't actually need force)
			await runTestEffect(
				push({ baseBranch: "main", force: true, silent: false }),
			)

			console.log = originalLog

			// Should be back on agency/feature branch (source)
			expect(await getCurrentBranch(tempDir)).toBe("agency/feature")

			// Should NOT have reported force push (since it wasn't actually used)
			expect(logMessages.some((msg) => msg.includes("Force pushed"))).toBe(
				false,
			)
			expect(logMessages.some((msg) => msg.includes("Pushed"))).toBe(true)
		})
	})

	describe("--gh flag", () => {
		test("handles gh CLI failure gracefully and continues", async () => {
			// Capture error output
			const originalError = console.error
			let errorMessages: string[] = []
			console.error = (msg: string) => {
				errorMessages.push(msg)
			}

			// Should not throw - command should complete despite gh failure
			// (gh will fail in test environment because there's no GitHub remote)
			await runTestEffect(push({ baseBranch: "main", gh: true, silent: true }))

			console.error = originalError

			// Should be back on agency/feature branch (command completes despite gh failure)
			expect(await getCurrentBranch(tempDir)).toBe("agency/feature")

			// Should have warned about gh failure
			expect(
				errorMessages.some((msg) => msg.includes("Failed to open GitHub PR")),
			).toBe(true)
		})

		test("does not call gh when --gh flag is not set", async () => {
			// Capture error output
			const originalError = console.error
			let errorMessages: string[] = []
			console.error = (msg: string) => {
				errorMessages.push(msg)
			}

			// Push without --gh flag
			await runTestEffect(push({ baseBranch: "main", silent: true }))

			console.error = originalError

			// Should be back on agency/feature branch (source)
			expect(await getCurrentBranch(tempDir)).toBe("agency/feature")

			// gh should NOT have been called (no error about GitHub PR)
			expect(errorMessages.some((msg) => msg.includes("GitHub PR"))).toBe(false)
		})
	})
})
