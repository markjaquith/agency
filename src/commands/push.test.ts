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
		injectedFiles: ["AGENTS.md", "TASK.md"],
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

		// Create a feature branch
		await createBranch(tempDir, "feature")
		await createCommit(tempDir, "Feature work")
	})

	afterEach(async () => {
		process.chdir(originalCwd)
		delete process.env.AGENCY_CONFIG_PATH
		await cleanupTempDir(tempDir)
	})

	describe("basic functionality", () => {
		test("creates PR branch, pushes it, and returns to source", async () => {
			// We're on feature branch
			expect(await getCurrentBranch(tempDir)).toBe("feature")

			// Run push command
			await runTestEffect(push({ baseBranch: "main", silent: true }))

			// Should be back on feature branch
			expect(await getCurrentBranch(tempDir)).toBe("feature")

			// PR branch should exist locally
			const branchesProc = Bun.spawn(["git", "branch"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			})
			await branchesProc.exited
			const branches = await new Response(branchesProc.stdout).text()
			expect(branches).toContain("feature--PR")

			// PR branch should exist on remote
			const remoteBranchesProc = Bun.spawn(
				["git", "ls-remote", "--heads", "origin", "feature--PR"],
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
			expect(remoteBranches).toContain("feature--PR")
		})

		test("works with custom branch name", async () => {
			await runTestEffect(
				push({
					baseBranch: "main",
					branch: "custom-pr-branch",
					silent: true,
				}),
			)

			// Should be back on feature branch
			expect(await getCurrentBranch(tempDir)).toBe("feature")

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

		test("recreates PR branch if it already exists", async () => {
			// First push
			await runTestEffect(push({ baseBranch: "main", silent: true }))

			// Make more changes on feature branch
			await checkoutBranch(tempDir, "feature")
			await createCommit(tempDir, "More feature work")

			// Second push should recreate the PR branch
			await runTestEffect(push({ baseBranch: "main", silent: true }))

			// Should still be back on feature branch
			expect(await getCurrentBranch(tempDir)).toBe("feature")
		})
	})

	describe("error handling", () => {
		test("throws error when already on PR branch", async () => {
			// Create and switch to PR branch
			await createBranch(tempDir, "feature--PR")

			// Try to run push from PR branch
			await expect(
				runTestEffect(push({ baseBranch: "main", silent: true })),
			).rejects.toThrow(/Already on PR branch/)
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

			// Push should fail
			await expect(
				runTestEffect(push({ baseBranch: "main", silent: true })),
			).rejects.toThrow(/Failed to push/)
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

			// Make changes on feature branch
			await checkoutBranch(tempDir, "feature")
			await createCommit(tempDir, "More feature work")

			// Modify the PR branch to create divergence
			await checkoutBranch(tempDir, "feature--PR")
			await createCommit(tempDir, "Direct PR branch commit")
			await Bun.spawn(["git", "push"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited

			// Go back to feature branch and try to push again with --force
			await checkoutBranch(tempDir, "feature")

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

			// Should be back on feature branch
			expect(await getCurrentBranch(tempDir)).toBe("feature")

			// Should have reported force push
			expect(logMessages.some((msg) => msg.includes("Force pushed"))).toBe(true)
		})

		test("suggests using --force when push is rejected without it", async () => {
			// First push
			await runTestEffect(push({ baseBranch: "main", silent: true }))

			// Make changes on feature branch
			await checkoutBranch(tempDir, "feature")
			await createCommit(tempDir, "More feature work")

			// Modify the PR branch to create divergence
			await checkoutBranch(tempDir, "feature--PR")
			await createCommit(tempDir, "Direct PR branch commit")
			await Bun.spawn(["git", "push"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited

			// Go back to feature branch and try to push without --force
			await checkoutBranch(tempDir, "feature")

			// Should throw error suggesting --force
			await expect(
				runTestEffect(push({ baseBranch: "main", silent: true })),
			).rejects.toThrow(/agency push --force/)

			// Should still be on feature branch (not left in intermediate state)
			expect(await getCurrentBranch(tempDir)).toBe("feature")
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

			// Should be back on feature branch
			expect(await getCurrentBranch(tempDir)).toBe("feature")

			// Should NOT have reported force push (since it wasn't actually used)
			expect(logMessages.some((msg) => msg.includes("Force pushed"))).toBe(
				false,
			)
			expect(logMessages.some((msg) => msg.includes("Pushed"))).toBe(true)
		})
	})
})
