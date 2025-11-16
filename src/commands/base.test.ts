import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { base, baseSet, baseGet } from "./base"
import { createTempDir, cleanupTempDir, initGitRepo } from "../test-utils"
import { getGitConfig } from "../utils/git"
import { getBaseBranchFromMetadata, writeAgencyMetadata } from "../types"

describe("base", () => {
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

	describe("base set", () => {
		test("sets base branch for current branch", async () => {
			// Create a feature branch
			await Bun.spawn(["git", "checkout", "-b", "feature"], {
				cwd: testDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited

			// Create agency.json first
			await writeAgencyMetadata(testDir, {
				version: 1,
				template: "test",
				injectedFiles: [],
				createdAt: new Date().toISOString(),
			})

			// Set base branch
			await baseSet({
				baseBranch: "main",
				silent: true,
			})

			// Verify it was saved
			const savedBase = await getBaseBranchFromMetadata(testDir)
			expect(savedBase).toBe("main")
		})

		test("sets repository-level default base branch", async () => {
			// Set repo-level base branch
			await baseSet({
				baseBranch: "main",
				repo: true,
				silent: true,
			})

			// Verify it was saved to git config
			const savedBase = await getGitConfig("agency.baseBranch", testDir)
			expect(savedBase).toBe("main")
		})

		test("throws error if base branch does not exist", async () => {
			await expect(
				baseSet({
					baseBranch: "nonexistent",
					silent: true,
				}),
			).rejects.toThrow("does not exist")
		})
	})

	describe("base get", () => {
		test("gets base branch for current branch", async () => {
			// Create a feature branch
			await Bun.spawn(["git", "checkout", "-b", "feature"], {
				cwd: testDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited

			// Create agency.json with base branch
			await writeAgencyMetadata(testDir, {
				version: 1,
				template: "test",
				injectedFiles: [],
				baseBranch: "main",
				createdAt: new Date().toISOString(),
			})

			// Mock console.log to capture output
			const logs: string[] = []
			const originalLog = console.log
			console.log = (...args: any[]) => logs.push(args.join(" "))

			try {
				await baseGet({ silent: false })
				expect(logs[0]).toBe("main")
			} finally {
				console.log = originalLog
			}
		})

		test("throws error if no base branch configured", async () => {
			// Create a feature branch
			await Bun.spawn(["git", "checkout", "-b", "feature"], {
				cwd: testDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited

			// Create agency.json without base branch
			await writeAgencyMetadata(testDir, {
				version: 1,
				template: "test",
				injectedFiles: [],
				createdAt: new Date().toISOString(),
			})

			await expect(baseGet({ silent: true })).rejects.toThrow(
				"No base branch configured",
			)
		})
	})

	describe("base command", () => {
		test("requires subcommand", async () => {
			await expect(base({ args: [], silent: true })).rejects.toThrow(
				"Subcommand is required",
			)
		})

		test("calls baseSet for 'set' subcommand", async () => {
			await Bun.spawn(["git", "checkout", "-b", "feature"], {
				cwd: testDir,
				stdout: "pipe",
				stderr: "pipe",
			}).exited

			await writeAgencyMetadata(testDir, {
				version: 1,
				template: "test",
				injectedFiles: [],
				createdAt: new Date().toISOString(),
			})

			await base({
				subcommand: "set",
				args: ["main"],
				silent: true,
			})

			const savedBase = await getBaseBranchFromMetadata(testDir)
			expect(savedBase).toBe("main")
		})

		test("throws error for unknown subcommand", async () => {
			await expect(
				base({
					subcommand: "unknown",
					args: [],
					silent: true,
				}),
			).rejects.toThrow("Unknown subcommand")
		})
	})
})
