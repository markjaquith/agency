import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { join } from "path"
import { rebase } from "./rebase"
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
	baseBranch?: string,
	emitBranch?: string,
): Promise<void> {
	const agencyJson = {
		version: 1,
		injectedFiles: ["AGENTS.md", "TASK.md", "opencode.json"],
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

async function fileExists(gitRoot: string, filename: string): Promise<boolean> {
	const file = Bun.file(join(gitRoot, filename))
	return await file.exists()
}

describe("rebase command", () => {
	let tempDir: string
	let originalCwd: string

	beforeEach(async () => {
		tempDir = await createTempDir()
		originalCwd = process.cwd()
		process.chdir(tempDir)

		// Set config path to non-existent file to use defaults
		process.env.AGENCY_CONFIG_PATH = join(tempDir, "non-existent-config.json")

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

	test("fails when not on an agency source branch", async () => {
		// Should fail on main branch without agency.json
		expect(
			runTestEffect(
				rebase({
					silent: true,
					verbose: false,
				}),
			),
		).rejects.toThrow(/does not have agency\.json/)
	})

	test("fails when agency.json is invalid", async () => {
		// Create invalid agency.json
		await Bun.write(join(tempDir, "agency.json"), "invalid json")
		await Bun.spawn(["git", "add", "agency.json"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited
		await createCommit(tempDir, "Add invalid agency.json")

		expect(
			runTestEffect(
				rebase({
					silent: true,
					verbose: false,
				}),
			),
		).rejects.toThrow(/does not have agency\.json/)
	})

	test("fails when there are uncommitted changes", async () => {
		// Create feature branch with agency.json
		await createBranch(tempDir, "agency--feature")
		await setupAgencyJson(tempDir, "main")

		// Create uncommitted changes
		await Bun.write(join(tempDir, "uncommitted.txt"), "uncommitted\n")

		expect(
			runTestEffect(
				rebase({
					silent: true,
					verbose: false,
				}),
			),
		).rejects.toThrow(/uncommitted changes/)
	})

	test("rebases source branch onto main successfully", async () => {
		// Create a feature branch
		await createBranch(tempDir, "agency--feature")
		await setupAgencyJson(tempDir, "main", "feature")
		await Bun.write(join(tempDir, "feature1.txt"), "feature 1\n")
		await Bun.spawn(["git", "add", "feature1.txt"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited
		await Bun.spawn(["git", "commit", "--no-verify", "-m", "Add feature 1"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited

		const commitCountBefore = await getCommitCount(tempDir, "agency--feature")

		// Add commits to main
		await checkoutBranch(tempDir, "main")
		await Bun.write(join(tempDir, "main1.txt"), "main 1\n")
		await Bun.spawn(["git", "add", "main1.txt"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited
		await Bun.spawn(["git", "commit", "--no-verify", "-m", "Main commit 1"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited
		await Bun.write(join(tempDir, "main2.txt"), "main 2\n")
		await Bun.spawn(["git", "add", "main2.txt"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited
		await Bun.spawn(["git", "commit", "--no-verify", "-m", "Main commit 2"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited

		// Switch back to feature and rebase
		await checkoutBranch(tempDir, "agency--feature")

		await runTestEffect(
			rebase({
				silent: true,
				verbose: false,
				baseBranch: "main",
			}),
		)

		// Verify we're still on the feature branch
		const currentBranch = await getCurrentBranch(tempDir)
		expect(currentBranch).toBe("agency--feature")

		// Verify commit count increased (original commits + new commits from main)
		const commitCountAfter = await getCommitCount(tempDir, "agency--feature")
		expect(commitCountAfter).toBe(commitCountBefore + 2)

		// Verify all files exist
		expect(await fileExists(tempDir, "initial.txt")).toBe(true)
		expect(await fileExists(tempDir, "main1.txt")).toBe(true)
		expect(await fileExists(tempDir, "main2.txt")).toBe(true)
		expect(await fileExists(tempDir, "feature1.txt")).toBe(true)
		expect(await fileExists(tempDir, "agency.json")).toBe(true)
	})

	test("uses base branch from agency.json by default", async () => {
		// Create a dev branch
		await checkoutBranch(tempDir, "main")
		await createBranch(tempDir, "develop")
		await Bun.write(join(tempDir, "dev1.txt"), "dev 1\n")
		await Bun.spawn(["git", "add", "dev1.txt"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited
		await Bun.spawn(["git", "commit", "--no-verify", "-m", "Dev commit 1"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited

		// Create feature branch based on develop
		await createBranch(tempDir, "agency--feature")
		await setupAgencyJson(tempDir, "develop", "feature")
		await Bun.write(join(tempDir, "feature1.txt"), "feature 1\n")
		await Bun.spawn(["git", "add", "feature1.txt"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited
		await Bun.spawn(["git", "commit", "--no-verify", "-m", "Add feature 1"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited

		// Add more commits to develop
		await checkoutBranch(tempDir, "develop")
		await Bun.write(join(tempDir, "dev2.txt"), "dev 2\n")
		await Bun.spawn(["git", "add", "dev2.txt"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited
		await Bun.spawn(["git", "commit", "--no-verify", "-m", "Dev commit 2"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited

		// Switch back to feature and rebase (should use develop from agency.json)
		await checkoutBranch(tempDir, "agency--feature")

		await runTestEffect(
			rebase({
				silent: true,
				verbose: false,
			}),
		)

		// Verify dev2.txt exists (came from develop)
		expect(await fileExists(tempDir, "dev2.txt")).toBe(true)
	})

	test("preserves agency files during rebase", async () => {
		// Create feature branch with agency files
		await createBranch(tempDir, "agency--feature")
		await setupAgencyJson(tempDir, "main", "feature")

		// Add TASK.md and AGENTS.md
		await Bun.write(join(tempDir, "TASK.md"), "# Task\nTest task\n")
		await Bun.write(join(tempDir, "AGENTS.md"), "# Agents\nTest agents\n")
		await Bun.spawn(["git", "add", "TASK.md", "AGENTS.md"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited
		await createCommit(tempDir, "Add agency files")

		// Add commit to main
		await checkoutBranch(tempDir, "main")
		await Bun.write(join(tempDir, "main1.txt"), "main 1\n")
		await Bun.spawn(["git", "add", "main1.txt"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited
		await Bun.spawn(["git", "commit", "--no-verify", "-m", "Main commit"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited

		// Rebase feature branch
		await checkoutBranch(tempDir, "agency--feature")

		await runTestEffect(
			rebase({
				silent: true,
				verbose: false,
				baseBranch: "main",
			}),
		)

		// Verify agency files still exist
		expect(await fileExists(tempDir, "agency.json")).toBe(true)
		expect(await fileExists(tempDir, "TASK.md")).toBe(true)
		expect(await fileExists(tempDir, "AGENTS.md")).toBe(true)

		// Verify content is preserved
		const taskContent = await Bun.file(join(tempDir, "TASK.md")).text()
		expect(taskContent).toContain("Test task")
	})

	test("can specify explicit base branch", async () => {
		// Create custom base branch
		await createBranch(tempDir, "custom-base")
		await Bun.write(join(tempDir, "custom.txt"), "custom\n")
		await Bun.spawn(["git", "add", "custom.txt"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited
		await Bun.spawn(
			["git", "commit", "--no-verify", "-m", "Custom base commit"],
			{
				cwd: tempDir,
				stdout: "pipe",
				stderr: "pipe",
			},
		).exited

		// Create feature branch from main
		await checkoutBranch(tempDir, "main")
		await createBranch(tempDir, "agency--feature")
		await setupAgencyJson(tempDir, "main", "feature")

		// Rebase onto custom-base instead of main
		await runTestEffect(
			rebase({
				silent: true,
				verbose: false,
				baseBranch: "custom-base",
			}),
		)

		// Verify custom.txt exists
		expect(await fileExists(tempDir, "custom.txt")).toBe(true)
	})

	test("updates emit branch with --emit flag", async () => {
		// Create feature branch with agency.json
		await createBranch(tempDir, "agency--feature")
		await setupAgencyJson(tempDir, "main", "feature")

		// Add commit to main
		await checkoutBranch(tempDir, "main")
		await Bun.write(join(tempDir, "main1.txt"), "main 1\n")
		await Bun.spawn(["git", "add", "main1.txt"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited
		await Bun.spawn(["git", "commit", "--no-verify", "-m", "Main commit"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited

		// Rebase feature branch with new emit branch name
		await checkoutBranch(tempDir, "agency--feature")

		await runTestEffect(
			rebase({
				silent: true,
				verbose: false,
				baseBranch: "main",
				emit: "new-emit-branch",
			}),
		)

		// Verify agency.json has updated emit branch
		const agencyJsonFile = Bun.file(join(tempDir, "agency.json"))
		const agencyJson = await agencyJsonFile.json()
		expect(agencyJson.emitBranch).toBe("new-emit-branch")

		// Verify we're still on the feature branch
		const currentBranch = await getCurrentBranch(tempDir)
		expect(currentBranch).toBe("agency--feature")

		// Verify there's a commit for the emit branch update
		const proc = Bun.spawn(["git", "log", "--oneline", "-1"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		})
		await proc.exited
		const output = await new Response(proc.stdout).text()
		expect(output).toContain(
			"chore: agency rebase (main) agency--feature → new-emit-branch",
		)
	})

	test("preserves other metadata when updating emit branch", async () => {
		// Create feature branch with agency.json containing standard fields
		await createBranch(tempDir, "agency--feature")
		const agencyJson = {
			version: 1,
			injectedFiles: ["AGENTS.md", "TASK.md", "opencode.json"],
			template: "test",
			createdAt: "2024-01-01T00:00:00.000Z",
			baseBranch: "main",
			emitBranch: "feature",
		}
		await Bun.write(
			join(tempDir, "agency.json"),
			JSON.stringify(agencyJson, null, 2) + "\n",
		)
		await Bun.spawn(["git", "add", "agency.json"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited
		await Bun.spawn(["git", "commit", "--no-verify", "-m", "Add agency.json"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited

		// Add commit to main
		await checkoutBranch(tempDir, "main")
		await Bun.write(join(tempDir, "main1.txt"), "main 1\n")
		await Bun.spawn(["git", "add", "main1.txt"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited
		await Bun.spawn(["git", "commit", "--no-verify", "-m", "Main commit"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited

		// Rebase with new emit branch
		await checkoutBranch(tempDir, "agency--feature")

		await runTestEffect(
			rebase({
				silent: true,
				verbose: false,
				baseBranch: "main",
				emit: "updated-emit",
			}),
		)

		// Verify all standard metadata fields are preserved
		const updatedJsonFile = Bun.file(join(tempDir, "agency.json"))
		const updatedJson = await updatedJsonFile.json()
		expect(updatedJson.version).toBe(1)
		expect(updatedJson.injectedFiles).toEqual([
			"AGENTS.md",
			"TASK.md",
			"opencode.json",
		])
		expect(updatedJson.template).toBe("test")
		expect(updatedJson.createdAt).toBe("2024-01-01T00:00:00.000Z")
		expect(updatedJson.baseBranch).toBe("main")
		expect(updatedJson.emitBranch).toBe("updated-emit")
	})

	test("supports deprecated --branch flag for backward compatibility", async () => {
		// Create feature branch with agency.json
		await createBranch(tempDir, "agency--feature")
		await setupAgencyJson(tempDir, "main", "feature")

		// Add commit to main
		await checkoutBranch(tempDir, "main")
		await Bun.write(join(tempDir, "main1.txt"), "main 1\n")
		await Bun.spawn(["git", "add", "main1.txt"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited
		await Bun.spawn(["git", "commit", "--no-verify", "-m", "Main commit"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited

		// Rebase feature branch with --branch (deprecated)
		await checkoutBranch(tempDir, "agency--feature")

		await runTestEffect(
			rebase({
				silent: true,
				verbose: false,
				baseBranch: "main",
				branch: "branch-flag-emit",
			}),
		)

		// Verify agency.json has updated emit branch
		const agencyJsonFile = Bun.file(join(tempDir, "agency.json"))
		const agencyJson = await agencyJsonFile.json()
		expect(agencyJson.emitBranch).toBe("branch-flag-emit")
	})
})
