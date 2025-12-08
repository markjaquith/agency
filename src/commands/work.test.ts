import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { join } from "path"
import { work } from "./work"
import {
	createTempDir,
	cleanupTempDir,
	initGitRepo,
	initAgency,
	runTestEffect,
	createCommit,
} from "../test-utils"
import { writeFileSync } from "node:fs"

describe("work command", () => {
	let tempDir: string
	let originalCwd: string

	beforeEach(async () => {
		tempDir = await createTempDir()
		originalCwd = process.cwd()
		process.chdir(tempDir)

		// Initialize git repo
		await initGitRepo(tempDir)
		await createCommit(tempDir, "Initial commit")
	})

	afterEach(async () => {
		process.chdir(originalCwd)
		await cleanupTempDir(tempDir)
	})

	describe("error handling", () => {
		test("throws error when TASK.md doesn't exist", async () => {
			expect(
				runTestEffect(work({ silent: true, _noExec: true })),
			).rejects.toThrow(
				"TASK.md not found. Run 'agency task' first to create it.",
			)
		})

		test("throws error when not in a git repository", async () => {
			const nonGitDir = await createTempDir()
			process.chdir(nonGitDir)

			expect(
				runTestEffect(work({ silent: true, _noExec: true })),
			).rejects.toThrow("Not in a git repository")

			await cleanupTempDir(nonGitDir)
		})
	})

	describe("TASK.md validation", () => {
		test("finds TASK.md in git root", async () => {
			// Create TASK.md
			const taskPath = join(tempDir, "TASK.md")
			writeFileSync(taskPath, "# Test Task\n\nSome task content")

			// Mock Bun.spawn to avoid actually running opencode
			// But allow git commands to pass through
			const originalSpawn = Bun.spawn
			let spawnCalled = false
			let spawnArgs: any[] = []

			// @ts-ignore - mocking for test
			Bun.spawn = (args: any, options: any) => {
				// Allow git commands to pass through
				if (Array.isArray(args) && args[0] === "git") {
					return originalSpawn(args, options)
				}
				spawnCalled = true
				spawnArgs = args
				return {
					exited: Promise.resolve(0),
				}
			}

			await runTestEffect(work({ silent: true, _noExec: true }))

			// @ts-ignore - restore
			Bun.spawn = originalSpawn

			expect(spawnCalled).toBe(true)
			expect(spawnArgs).toEqual(["opencode", "-p", "Start the task"])
		})
	})

	describe("opencode execution", () => {
		test("passes correct arguments to opencode", async () => {
			// Create TASK.md
			const taskPath = join(tempDir, "TASK.md")
			writeFileSync(taskPath, "# Test Task\n\nSome task content")

			// Mock Bun.spawn
			const originalSpawn = Bun.spawn
			let capturedArgs: string[] = []
			let capturedOptions: any = null

			// @ts-ignore - mocking for test
			Bun.spawn = (args: any, options: any) => {
				// Allow git commands to pass through
				if (Array.isArray(args) && args[0] === "git") {
					return originalSpawn(args, options)
				}
				capturedArgs = args
				capturedOptions = options
				return {
					exited: Promise.resolve(0),
					exitCode: 0,
					stdout: new ReadableStream(),
					stderr: new ReadableStream(),
				}
			}

			await runTestEffect(work({ silent: true, _noExec: true }))

			// @ts-ignore - restore
			Bun.spawn = originalSpawn

			expect(capturedArgs).toEqual(["opencode", "-p", "Start the task"])
			// On macOS, temp directories can have /private prefix
			expect(
				capturedOptions.cwd === tempDir ||
					capturedOptions.cwd === `/private${tempDir}`,
			).toBe(true)
			expect(capturedOptions.stdout).toEqual("inherit")
			expect(capturedOptions.stderr).toEqual("inherit")
		})

		test("throws error when opencode exits with non-zero code", async () => {
			// Create TASK.md
			const taskPath = join(tempDir, "TASK.md")
			writeFileSync(taskPath, "# Test Task\n\nSome task content")

			// Mock Bun.spawn to simulate failure
			const originalSpawn = Bun.spawn

			// @ts-ignore - mocking for test
			Bun.spawn = (args: any, options: any) => {
				// Allow git commands to pass through
				if (Array.isArray(args) && args[0] === "git") {
					return originalSpawn(args, options)
				}
				return {
					exited: Promise.resolve(1),
					exitCode: 1,
					stdout: new ReadableStream(),
					stderr: new ReadableStream(),
				}
			}

			expect(
				runTestEffect(work({ silent: true, _noExec: true })),
			).rejects.toThrow("opencode exited with code 1")

			// @ts-ignore - restore
			Bun.spawn = originalSpawn
		})
	})

	describe("silent mode", () => {
		test("verbose mode logs debug information", async () => {
			// Create TASK.md
			const taskPath = join(tempDir, "TASK.md")
			writeFileSync(taskPath, "# Test Task\n\nSome task content")

			// Mock Bun.spawn
			const originalSpawn = Bun.spawn
			// @ts-ignore - mocking for test
			Bun.spawn = (args: any, options: any) => {
				// Allow git commands to pass through
				if (Array.isArray(args) && args[0] === "git") {
					return originalSpawn(args, options)
				}
				return {
					exited: Promise.resolve(0),
					exitCode: 0,
					stdout: new ReadableStream(),
					stderr: new ReadableStream(),
				}
			}

			// Capture console.log
			const originalLog = console.log
			let logMessages: string[] = []
			console.log = (msg: string) => {
				logMessages.push(msg)
			}

			await runTestEffect(work({ silent: false, verbose: true, _noExec: true }))

			console.log = originalLog
			// @ts-ignore - restore
			Bun.spawn = originalSpawn

			expect(logMessages.some((msg) => msg.includes("Found TASK.md"))).toBe(
				true,
			)
			expect(logMessages.some((msg) => msg.includes("Running opencode"))).toBe(
				true,
			)
		})

		test("silent flag suppresses verbose output", async () => {
			// Create TASK.md
			const taskPath = join(tempDir, "TASK.md")
			writeFileSync(taskPath, "# Test Task\n\nSome task content")

			// Mock Bun.spawn
			const originalSpawn = Bun.spawn
			// @ts-ignore - mocking for test
			Bun.spawn = (args: any, options: any) => {
				// Allow git commands to pass through
				if (Array.isArray(args) && args[0] === "git") {
					return originalSpawn(args, options)
				}
				return {
					exited: Promise.resolve(0),
					exitCode: 0,
					stdout: new ReadableStream(),
					stderr: new ReadableStream(),
				}
			}

			// Capture console.log
			const originalLog = console.log
			let logCalled = false
			console.log = () => {
				logCalled = true
			}

			await work({ silent: true, verbose: true, _noExec: true })

			console.log = originalLog
			// @ts-ignore - restore
			Bun.spawn = originalSpawn

			expect(logCalled).toBe(false)
		})
	})
})
