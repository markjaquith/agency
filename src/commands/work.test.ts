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

/**
 * Helper to mock CLI tool detection and execution for work command tests.
 * Returns restore function to clean up mocks.
 *
 * @param options Configuration for the mock
 * @param options.hasOpencode Whether 'which opencode' should succeed (default: true)
 * @param options.hasClaude Whether 'which claude' should succeed (default: false)
 * @param options.onSpawn Callback when Bun.spawn is called (non-git commands)
 * @returns Restore function to clean up mocks
 */
function mockCliTools(
	options: {
		hasOpencode?: boolean
		hasClaude?: boolean
		onSpawn?: (args: string[], options: any) => any
	} = {},
) {
	const { hasOpencode = true, hasClaude = false, onSpawn } = options

	const originalSpawn = Bun.spawn
	const originalSpawnSync = Bun.spawnSync

	// @ts-ignore - mocking for test
	Bun.spawnSync = (args: any, options: any) => {
		// Mock which command to return success/failure based on config
		if (Array.isArray(args) && args[0] === "which") {
			if (args[1] === "opencode") {
				return { exitCode: hasOpencode ? 0 : 1 }
			}
			if (args[1] === "claude") {
				return { exitCode: hasClaude ? 0 : 1 }
			}
		}
		return originalSpawnSync(args, options)
	}

	// @ts-ignore - mocking for test
	Bun.spawn = (args: any, options: any) => {
		// Allow git commands to pass through
		if (Array.isArray(args) && args[0] === "git") {
			return originalSpawn(args, options)
		}

		// Call custom handler if provided
		if (onSpawn) {
			return onSpawn(args, options)
		}

		// Default mock response
		return {
			exited: Promise.resolve(0),
			exitCode: 0,
			stdout: new ReadableStream(),
			stderr: new ReadableStream(),
		}
	}

	// Return restore function
	return () => {
		// @ts-ignore - restore
		Bun.spawn = originalSpawn
		// @ts-ignore - restore
		Bun.spawnSync = originalSpawnSync
	}
}

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

			let spawnCalled = false
			let spawnArgs: any[] = []

			const restore = mockCliTools({
				onSpawn: (args) => {
					spawnCalled = true
					spawnArgs = args
					return {
						exited: Promise.resolve(0),
					}
				},
			})

			await runTestEffect(work({ silent: true, _noExec: true }))

			restore()

			expect(spawnCalled).toBe(true)
			expect(spawnArgs).toEqual(["opencode", "-p", "Start the task"])
		})
	})

	describe("opencode execution", () => {
		test("passes correct arguments to opencode", async () => {
			// Create TASK.md
			const taskPath = join(tempDir, "TASK.md")
			writeFileSync(taskPath, "# Test Task\n\nSome task content")

			let capturedArgs: string[] = []
			let capturedOptions: any = null

			const restore = mockCliTools({
				onSpawn: (args, options) => {
					capturedArgs = args
					capturedOptions = options
					return {
						exited: Promise.resolve(0),
						exitCode: 0,
						stdout: new ReadableStream(),
						stderr: new ReadableStream(),
					}
				},
			})

			await runTestEffect(work({ silent: true, _noExec: true }))

			restore()

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

			const restore = mockCliTools({
				onSpawn: () => ({
					exited: Promise.resolve(1),
					exitCode: 1,
					stdout: new ReadableStream(),
					stderr: new ReadableStream(),
				}),
			})

			expect(
				runTestEffect(work({ silent: true, _noExec: true })),
			).rejects.toThrow("opencode exited with code 1")

			restore()
		})
	})

	describe("silent mode", () => {
		test("verbose mode logs debug information", async () => {
			// Create TASK.md
			const taskPath = join(tempDir, "TASK.md")
			writeFileSync(taskPath, "# Test Task\n\nSome task content")

			const restore = mockCliTools()

			// Capture console.log
			const originalLog = console.log
			let logMessages: string[] = []
			console.log = (msg: string) => {
				logMessages.push(msg)
			}

			await runTestEffect(work({ silent: false, verbose: true, _noExec: true }))

			console.log = originalLog
			restore()

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

			const restore = mockCliTools()

			// Capture console.log
			const originalLog = console.log
			let logCalled = false
			console.log = () => {
				logCalled = true
			}

			await work({ silent: true, verbose: true, _noExec: true })

			console.log = originalLog
			restore()

			expect(logCalled).toBe(false)
		})
	})

	describe("CLI selection flags", () => {
		test("--opencode flag forces use of OpenCode", async () => {
			// Create TASK.md
			const taskPath = join(tempDir, "TASK.md")
			writeFileSync(taskPath, "# Test Task\n\nSome task content")

			let capturedArgs: string[] = []

			const restore = mockCliTools({
				onSpawn: (args) => {
					capturedArgs = args
					return {
						exited: Promise.resolve(0),
						exitCode: 0,
						stdout: new ReadableStream(),
						stderr: new ReadableStream(),
					}
				},
			})

			await runTestEffect(work({ silent: true, _noExec: true, opencode: true }))

			restore()

			expect(capturedArgs).toEqual(["opencode", "-p", "Start the task"])
		})

		test("--claude flag forces use of Claude Code", async () => {
			// Create TASK.md
			const taskPath = join(tempDir, "TASK.md")
			writeFileSync(taskPath, "# Test Task\n\nSome task content")

			let capturedArgs: string[] = []

			const restore = mockCliTools({
				hasClaude: true,
				onSpawn: (args) => {
					capturedArgs = args
					return {
						exited: Promise.resolve(0),
						exitCode: 0,
						stdout: new ReadableStream(),
						stderr: new ReadableStream(),
					}
				},
			})

			await runTestEffect(work({ silent: true, _noExec: true, claude: true }))

			restore()

			expect(capturedArgs).toEqual(["claude", "Start the task"])
		})

		test("throws error when both --opencode and --claude flags are used", async () => {
			// Create TASK.md
			const taskPath = join(tempDir, "TASK.md")
			writeFileSync(taskPath, "# Test Task\n\nSome task content")

			expect(
				runTestEffect(
					work({ silent: true, _noExec: true, opencode: true, claude: true }),
				),
			).rejects.toThrow(
				"Cannot use both --opencode and --claude flags together. Choose one.",
			)
		})

		test("throws error when --opencode is used but opencode is not installed", async () => {
			// Create TASK.md
			const taskPath = join(tempDir, "TASK.md")
			writeFileSync(taskPath, "# Test Task\n\nSome task content")

			const restore = mockCliTools({ hasOpencode: false })

			expect(
				runTestEffect(work({ silent: true, _noExec: true, opencode: true })),
			).rejects.toThrow(
				"opencode CLI tool not found. Please install OpenCode or remove the --opencode flag.",
			)

			restore()
		})

		test("throws error when --claude is used but claude is not installed", async () => {
			// Create TASK.md
			const taskPath = join(tempDir, "TASK.md")
			writeFileSync(taskPath, "# Test Task\n\nSome task content")

			const restore = mockCliTools({ hasClaude: false })

			expect(
				runTestEffect(work({ silent: true, _noExec: true, claude: true })),
			).rejects.toThrow(
				"claude CLI tool not found. Please install Claude Code or remove the --claude flag.",
			)

			restore()
		})
	})

	describe("extra arguments", () => {
		test("passes extra args to opencode", async () => {
			// Create TASK.md
			const taskPath = join(tempDir, "TASK.md")
			writeFileSync(taskPath, "# Test Task\n\nSome task content")

			let capturedArgs: string[] = []

			const restore = mockCliTools({
				onSpawn: (args) => {
					capturedArgs = args
					return {
						exited: Promise.resolve(0),
						exitCode: 0,
						stdout: new ReadableStream(),
						stderr: new ReadableStream(),
					}
				},
			})

			await runTestEffect(
				work({
					silent: true,
					_noExec: true,
					extraArgs: ["--model", "claude-sonnet-4-20250514"],
				}),
			)

			restore()

			expect(capturedArgs).toEqual([
				"opencode",
				"-p",
				"Start the task",
				"--model",
				"claude-sonnet-4-20250514",
			])
		})

		test("passes extra args to claude", async () => {
			// Create TASK.md
			const taskPath = join(tempDir, "TASK.md")
			writeFileSync(taskPath, "# Test Task\n\nSome task content")

			let capturedArgs: string[] = []

			const restore = mockCliTools({
				hasClaude: true,
				onSpawn: (args) => {
					capturedArgs = args
					return {
						exited: Promise.resolve(0),
						exitCode: 0,
						stdout: new ReadableStream(),
						stderr: new ReadableStream(),
					}
				},
			})

			await runTestEffect(
				work({
					silent: true,
					_noExec: true,
					claude: true,
					extraArgs: ["--arbitrary", "switches"],
				}),
			)

			restore()

			expect(capturedArgs).toEqual([
				"claude",
				"Start the task",
				"--arbitrary",
				"switches",
			])
		})

		test("works without extra args", async () => {
			// Create TASK.md
			const taskPath = join(tempDir, "TASK.md")
			writeFileSync(taskPath, "# Test Task\n\nSome task content")

			let capturedArgs: string[] = []

			const restore = mockCliTools({
				onSpawn: (args) => {
					capturedArgs = args
					return {
						exited: Promise.resolve(0),
						exitCode: 0,
						stdout: new ReadableStream(),
						stderr: new ReadableStream(),
					}
				},
			})

			await runTestEffect(work({ silent: true, _noExec: true }))

			restore()

			expect(capturedArgs).toEqual(["opencode", "-p", "Start the task"])
		})
	})
})
