import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { get, getBase, getTemplate } from "./get"
import { createTempDir, cleanupTempDir, initGitRepo } from "../test-utils"
import { setGitConfig } from "../utils/git"
import { writeAgencyMetadata } from "../types"
import { join } from "path"

describe("get", () => {
	let testDir: string
	let originalCwd: string

	beforeEach(async () => {
		originalCwd = process.cwd()
		testDir = await createTempDir()
		await initGitRepo(testDir)
		process.chdir(testDir)
	})

	afterEach(async () => {
		process.chdir(originalCwd)
		await cleanupTempDir(testDir)
	})

	test("gets base branch for current branch", async () => {
		// Create a feature branch
		await Bun.spawn(["git", "checkout", "-b", "feature"], {
			cwd: testDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited

		// Set base branch via agency.json
		await writeAgencyMetadata(testDir, {
			version: 1,
			template: "test",
			injectedFiles: [],
			baseBranch: "main",
			createdAt: new Date().toISOString(),
		})

		// Get base branch - should not throw
		await getBase({
			silent: true,
		})
	})

	test("throws error if not in git repository", async () => {
		process.chdir(join(testDir, ".."))

		await expect(
			getBase({
				silent: true,
			}),
		).rejects.toThrow("Not in a git repository")
	})

	test("throws error if base branch not configured", async () => {
		await Bun.spawn(["git", "checkout", "-b", "feature"], {
			cwd: testDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited

		await expect(
			getBase({
				silent: true,
			}),
		).rejects.toThrow("No base branch configured")
	})

	test("get command with base subcommand works", async () => {
		await Bun.spawn(["git", "checkout", "-b", "feature"], {
			cwd: testDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited

		// Set base branch via agency.json
		await writeAgencyMetadata(testDir, {
			version: 1,
			template: "test",
			injectedFiles: [],
			baseBranch: "main",
			createdAt: new Date().toISOString(),
		})

		// Should not throw
		await get({
			subcommand: "base",
			silent: true,
		})
	})

	test("get command throws error without subcommand", async () => {
		await expect(
			get({
				silent: true,
			}),
		).rejects.toThrow("Subcommand is required")
	})

	test("get command throws error with unknown subcommand", async () => {
		await expect(
			get({
				subcommand: "unknown",
				silent: true,
			}),
		).rejects.toThrow("Unknown subcommand")
	})

	test("gets template for current repository", async () => {
		// Set template
		await setGitConfig("agency.template", "work", testDir)

		// Get template - should not throw
		await getTemplate({
			silent: true,
		})
	})

	test("throws error if template not configured", async () => {
		await expect(
			getTemplate({
				silent: true,
			}),
		).rejects.toThrow("No template configured")
	})

	test("get command with template subcommand works", async () => {
		await setGitConfig("agency.template", "client", testDir)

		// Should not throw
		await get({
			subcommand: "template",
			silent: true,
		})
	})
})
