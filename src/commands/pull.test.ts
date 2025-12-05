import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { join } from "path"
import { pull } from "./pull"
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

async function setupAgencyJson(
	gitRoot: string,
	emitBranch?: string,
): Promise<void> {
	const agencyJson = {
		version: 1,
		injectedFiles: ["AGENTS.MD", "TASK.md"],
		template: "test",
		createdAt: new Date().toISOString(),
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

async function getCommitCount(cwd: string, branch: string): Promise<number> {
	const proc = Bun.spawn(["git", "rev-list", "--count", branch], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	})
	await proc.exited
	const output = await new Response(proc.stdout).text()
	return parseInt(output.trim(), 10)
}

async function getLatestCommitMessage(cwd: string): Promise<string> {
	const proc = Bun.spawn(["git", "log", "-1", "--pretty=%B"], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	})
	await proc.exited
	const output = await new Response(proc.stdout).text()
	return output.trim()
}

describe("pull command", () => {
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
	})

	afterEach(async () => {
		process.chdir(originalCwd)
		delete process.env.AGENCY_CONFIG_PATH
		await cleanupTempDir(tempDir)
	})

	describe("basic functionality", () => {
		test("pulls commits from remote emit branch to source branch", async () => {
			// Setup agency.json
			await setupAgencyJson(tempDir)

			// Create a source branch (with agency/ prefix per new default config)
			await createBranch(tempDir, "agency/feature")
			await createCommit(tempDir, "Feature work")

			// Create emit branch
			await createBranch(tempDir, "feature")
			await createCommit(tempDir, "Emit commit 1")
			await createCommit(tempDir, "Emit commit 2")

			// Push emit branch to remote
			await Bun.spawn(["git", "push", "-u", "origin", "feature"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited

			// Go back to source branch and reset to before the emit commits
			await checkoutBranch(tempDir, "agency/feature")
			const beforeCommitCount = await getCommitCount(tempDir, "agency/feature")

			// Run pull command
			await runTestEffect(pull({ silent: true }))

			// Should still be on source branch
			expect(await getCurrentBranch(tempDir)).toBe("agency/feature")

			// Should have the new commits
			const afterCommitCount = await getCommitCount(tempDir, "agency/feature")
			expect(afterCommitCount).toBe(beforeCommitCount + 2)

			// Last commit should be "Emit commit 2"
			const lastCommit = await getLatestCommitMessage(tempDir)
			expect(lastCommit).toBe("Emit commit 2")
		})

		test("works when starting from emit branch", async () => {
			// Setup agency.json on main
			await setupAgencyJson(tempDir)

			// Create a source branch
			await createBranch(tempDir, "agency/feature")
			// Update agency.json to set emitBranch
			await setupAgencyJson(tempDir, "feature")

			// Create emit branch from source (it will have the agency.json but we'll cherry-pick without it)
			await createBranch(tempDir, "feature")

			// Remove agency.json from emit branch to simulate an emitted branch
			await Bun.spawn(["git", "rm", "agency.json"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited
			await createCommit(tempDir, "Remove agency.json")
			await createCommit(tempDir, "Emit commit")

			// Push emit branch to remote
			await Bun.spawn(["git", "push", "-u", "origin", "feature"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited

			// Go to source branch and remove the commits that were added on emit
			await checkoutBranch(tempDir, "agency/feature")
			await Bun.spawn(["git", "reset", "--hard", "HEAD~2"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited

			// Now switch to emit branch
			await checkoutBranch(tempDir, "feature")

			// Run pull - should switch to source branch and cherry-pick
			await runTestEffect(pull({ silent: true }))

			// Should be on source branch
			expect(await getCurrentBranch(tempDir)).toBe("agency/feature")

			// Should have the emit commit
			const lastCommit = await getLatestCommitMessage(tempDir)
			expect(lastCommit).toBe("Emit commit")
		})

		test("handles no new commits gracefully", async () => {
			// Setup agency.json
			await setupAgencyJson(tempDir)

			// Create a source branch
			await createBranch(tempDir, "agency/feature")
			await createCommit(tempDir, "Feature work")

			// Create emit branch with same commits
			await createBranch(tempDir, "feature")

			// Push emit branch to remote
			await Bun.spawn(["git", "push", "-u", "origin", "feature"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited

			// Go back to source branch
			await checkoutBranch(tempDir, "agency/feature")

			// Capture output
			const originalLog = console.log
			let logMessages: string[] = []
			console.log = (msg: string) => {
				logMessages.push(msg)
			}

			// Run pull command - should report no new commits
			await runTestEffect(pull({ silent: false }))

			console.log = originalLog

			// Should report no new commits
			expect(logMessages.some((msg) => msg.includes("No new commits"))).toBe(
				true,
			)

			// Should still be on source branch
			expect(await getCurrentBranch(tempDir)).toBe("agency/feature")
		})

		test("works with custom remote", async () => {
			// Setup agency.json
			await setupAgencyJson(tempDir)

			// Create a source branch
			await createBranch(tempDir, "agency/feature")
			await createCommit(tempDir, "Feature work")

			// Create emit branch
			await createBranch(tempDir, "feature")
			await createCommit(tempDir, "Emit commit")

			// Add a second remote
			const upstreamDir = await setupBareRemote(tempDir)
			await Bun.spawn(["git", "remote", "add", "upstream", upstreamDir], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited

			// Push emit branch to upstream
			await Bun.spawn(["git", "push", "-u", "upstream", "feature"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited

			// Go back to source branch and reset
			await checkoutBranch(tempDir, "agency/feature")

			// Run pull with custom remote
			await runTestEffect(pull({ remote: "upstream", silent: true }))

			// Should still be on source branch
			expect(await getCurrentBranch(tempDir)).toBe("agency/feature")

			// Should have the new commit
			const lastCommit = await getLatestCommitMessage(tempDir)
			expect(lastCommit).toBe("Emit commit")
		})
	})

	describe("error handling", () => {
		test("throws error when not in a git repository", async () => {
			const nonGitDir = await createTempDir()
			process.chdir(nonGitDir)

			await expect(runTestEffect(pull({ silent: true }))).rejects.toThrow(
				"Not in a git repository",
			)

			await cleanupTempDir(nonGitDir)
		})

		test("handles case when only source branch exists (no emit on remote)", async () => {
			// Setup agency.json
			await setupAgencyJson(tempDir)

			// Create a source branch
			await createBranch(tempDir, "agency/feature")
			await setupAgencyJson(tempDir, "feature")
			await createCommit(tempDir, "Feature work")

			// Don't create or push emit branch - just test that pull handles this gracefully
			// Run pull - should fail because remote emit branch doesn't exist
			await expect(runTestEffect(pull({ silent: true }))).rejects.toThrow()
		})

		test("throws error when remote emit branch does not exist", async () => {
			// Setup agency.json
			await setupAgencyJson(tempDir)

			// Create a source branch
			await createBranch(tempDir, "agency/feature")
			await setupAgencyJson(tempDir, "feature")
			await createCommit(tempDir, "Feature work")

			// Run pull - should fail because remote emit branch doesn't exist
			await expect(runTestEffect(pull({ silent: true }))).rejects.toThrow(
				"Failed to fetch",
			)
		})
	})

	describe("silent mode", () => {
		test("silent flag suppresses output", async () => {
			// Setup agency.json
			await setupAgencyJson(tempDir)

			// Create a source branch
			await createBranch(tempDir, "agency/feature")
			await createCommit(tempDir, "Feature work")

			// Create emit branch
			await createBranch(tempDir, "feature")
			await createCommit(tempDir, "Emit commit")

			// Push emit branch to remote
			await Bun.spawn(["git", "push", "-u", "origin", "feature"], {
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited

			// Go back to source branch
			await checkoutBranch(tempDir, "agency/feature")

			// Capture output
			const originalLog = console.log
			let logCalled = false
			console.log = () => {
				logCalled = true
			}

			await runTestEffect(pull({ silent: true }))

			console.log = originalLog
			expect(logCalled).toBe(false)
		})
	})
})
