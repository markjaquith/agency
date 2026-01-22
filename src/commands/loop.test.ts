import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { join } from "path"
import { loop } from "./loop"
import {
	createTempDir,
	cleanupTempDir,
	initGitRepo,
	runTestEffect,
	createCommit,
} from "../test-utils"
import { writeFileSync } from "node:fs"

/**
 * Create a ReadableStream that immediately closes (for mock responses)
 */
function createEmptyStream() {
	return new ReadableStream({
		start(controller) {
			controller.close()
		},
	})
}

/**
 * Helper to mock CLI tool detection and execution for loop command tests.
 * Returns restore function to clean up mocks.
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
		// Allow git commands to pass through (check both "git" and "/usr/bin/git")
		if (
			Array.isArray(args) &&
			(args[0] === "git" || args[0] === "/usr/bin/git")
		) {
			return originalSpawn(args, options)
		}

		// Call custom handler if provided
		if (onSpawn) {
			return onSpawn(args, options)
		}

		// Default mock response - use properly closing streams
		return {
			exited: Promise.resolve(0),
			exitCode: 0,
			stdout: createEmptyStream(),
			stderr: createEmptyStream(),
		}
	}

	return () => {
		// @ts-ignore - restore
		Bun.spawn = originalSpawn
		// @ts-ignore - restore
		Bun.spawnSync = originalSpawnSync
	}
}

describe("loop command", () => {
	let tempDir: string
	let originalCwd: string

	beforeEach(async () => {
		tempDir = await createTempDir()
		originalCwd = process.cwd()
		process.chdir(tempDir)

		await initGitRepo(tempDir)
		await createCommit(tempDir, "Initial commit")
	})

	afterEach(async () => {
		process.chdir(originalCwd)
		await cleanupTempDir(tempDir)
	})

	describe("error handling", () => {
		test("throws error when TASK.md doesn't exist", async () => {
			const restore = mockCliTools()

			await expect(
				runTestEffect(loop({ silent: true, maxLoops: 1 })),
			).rejects.toThrow(
				"TASK.md not found. Run 'agency task' first to create it.",
			)

			restore()
		})

		test("throws error when not in a git repository", async () => {
			const nonGitDir = await createTempDir()
			process.chdir(nonGitDir)

			const restore = mockCliTools()

			await expect(
				runTestEffect(loop({ silent: true, maxLoops: 1 })),
			).rejects.toThrow("Not in a git repository")

			restore()
			await cleanupTempDir(nonGitDir)
		})

		test("throws error when both --opencode and --claude flags are used", async () => {
			const taskPath = join(tempDir, "TASK.md")
			writeFileSync(taskPath, "# Test Task\n\n- [ ] Do something")

			await expect(
				runTestEffect(loop({ silent: true, opencode: true, claude: true })),
			).rejects.toThrow(
				"Cannot use both --opencode and --claude flags together. Choose one.",
			)
		})

		test("throws error when --opencode is used but opencode is not installed", async () => {
			const taskPath = join(tempDir, "TASK.md")
			writeFileSync(taskPath, "# Test Task\n\n- [ ] Do something")

			const restore = mockCliTools({ hasOpencode: false })

			await expect(
				runTestEffect(loop({ silent: true, opencode: true })),
			).rejects.toThrow(
				"opencode CLI tool not found. Please install OpenCode or remove the --opencode flag.",
			)

			restore()
		})

		test("throws error when --claude is used but claude is not installed", async () => {
			const taskPath = join(tempDir, "TASK.md")
			writeFileSync(taskPath, "# Test Task\n\n- [ ] Do something")

			const restore = mockCliTools({ hasClaude: false })

			await expect(
				runTestEffect(loop({ silent: true, claude: true })),
			).rejects.toThrow(
				"claude CLI tool not found. Please install Claude Code or remove the --claude flag.",
			)

			restore()
		})

		test("throws error when neither opencode nor claude is installed", async () => {
			const taskPath = join(tempDir, "TASK.md")
			writeFileSync(taskPath, "# Test Task\n\n- [ ] Do something")

			const restore = mockCliTools({ hasOpencode: false, hasClaude: false })

			await expect(
				runTestEffect(loop({ silent: true, maxLoops: 1 })),
			).rejects.toThrow(
				"Neither opencode nor claude CLI tool found. Please install OpenCode or Claude Code.",
			)

			restore()
		})

		test("throws error when minLoops is greater than maxLoops", async () => {
			const taskPath = join(tempDir, "TASK.md")
			writeFileSync(taskPath, "# Test Task")

			const restore = mockCliTools()

			await expect(
				runTestEffect(loop({ silent: true, minLoops: 5, maxLoops: 3 })),
			).rejects.toThrow("--min-loops cannot be greater than --max-loops")

			restore()
		})
	})

	describe("CLI selection", () => {
		test("uses opencode by default when available", async () => {
			const taskPath = join(tempDir, "TASK.md")
			writeFileSync(taskPath, "# Test Task\n\n- [x] Already done")

			let capturedArgs: string[] = []
			const restore = mockCliTools({
				onSpawn: (args) => {
					capturedArgs = args
					return {
						exited: Promise.resolve(0),
						exitCode: 0,
						stdout: createEmptyStream(),
						stderr: createEmptyStream(),
					}
				},
			})

			await runTestEffect(loop({ silent: true, maxLoops: 1 }))
			restore()

			expect(capturedArgs[0]).toBe("opencode")
		})

		test("uses claude when --claude flag is set", async () => {
			const taskPath = join(tempDir, "TASK.md")
			writeFileSync(taskPath, "# Test Task\n\n- [x] Already done")

			let capturedArgs: string[] = []
			const restore = mockCliTools({
				hasClaude: true,
				onSpawn: (args) => {
					capturedArgs = args
					return {
						exited: Promise.resolve(0),
						exitCode: 0,
						stdout: createEmptyStream(),
						stderr: createEmptyStream(),
					}
				},
			})

			await runTestEffect(loop({ silent: true, maxLoops: 1, claude: true }))
			restore()

			expect(capturedArgs[0]).toBe("claude")
		})
	})

	describe("loop behavior", () => {
		test("stops when all tasks are complete", async () => {
			const taskPath = join(tempDir, "TASK.md")
			writeFileSync(taskPath, "# Test Task\n\n- [x] Already done")

			let spawnCount = 0
			const restore = mockCliTools({
				onSpawn: () => {
					spawnCount++
					return {
						exited: Promise.resolve(0),
						exitCode: 0,
						stdout: createEmptyStream(),
						stderr: createEmptyStream(),
					}
				},
			})

			await runTestEffect(loop({ silent: true }))
			restore()

			// Should run exactly once and then stop since task is complete
			expect(spawnCount).toBe(1)
		})

		test("respects maxLoops option", async () => {
			const taskPath = join(tempDir, "TASK.md")
			writeFileSync(taskPath, "# Test Task\n\n- [ ] Never done")

			let spawnCount = 0
			const restore = mockCliTools({
				onSpawn: () => {
					spawnCount++
					return {
						exited: Promise.resolve(0),
						exitCode: 0,
						stdout: createEmptyStream(),
						stderr: createEmptyStream(),
					}
				},
			})

			await runTestEffect(loop({ silent: true, maxLoops: 3 }))
			restore()

			expect(spawnCount).toBe(3)
		})

		test("respects minLoops option even when tasks complete early", async () => {
			const taskPath = join(tempDir, "TASK.md")
			writeFileSync(taskPath, "# Test Task\n\n- [x] Already done")

			let spawnCount = 0
			const restore = mockCliTools({
				onSpawn: () => {
					spawnCount++
					return {
						exited: Promise.resolve(0),
						exitCode: 0,
						stdout: createEmptyStream(),
						stderr: createEmptyStream(),
					}
				},
			})

			await runTestEffect(loop({ silent: true, minLoops: 3 }))
			restore()

			expect(spawnCount).toBe(3)
		})

		test("passes correct prompt to opencode", async () => {
			const taskPath = join(tempDir, "TASK.md")
			writeFileSync(taskPath, "# Test Task\n\n- [x] Already done")

			let capturedArgs: string[] = []
			const restore = mockCliTools({
				onSpawn: (args) => {
					capturedArgs = args
					return {
						exited: Promise.resolve(0),
						exitCode: 0,
						stdout: createEmptyStream(),
						stderr: createEmptyStream(),
					}
				},
			})

			await runTestEffect(loop({ silent: true, maxLoops: 1 }))
			restore()

			// opencode uses `opencode run "prompt"` for non-interactive mode
			expect(capturedArgs).toEqual([
				"opencode",
				"run",
				expect.stringContaining("Find the next logical task from TASK.md"),
			])
		})

		test("passes correct prompt to claude", async () => {
			const taskPath = join(tempDir, "TASK.md")
			writeFileSync(taskPath, "# Test Task\n\n- [x] Already done")

			let capturedArgs: string[] = []
			const restore = mockCliTools({
				hasClaude: true,
				onSpawn: (args) => {
					capturedArgs = args
					return {
						exited: Promise.resolve(0),
						exitCode: 0,
						stdout: createEmptyStream(),
						stderr: createEmptyStream(),
					}
				},
			})

			await runTestEffect(loop({ silent: true, maxLoops: 1, claude: true }))
			restore()

			// Claude doesn't use --prompt flag
			expect(capturedArgs[0]).toBe("claude")
			expect(capturedArgs[1]).toContain("Find the next logical task")
		})

		test("handles empty TASK.md as complete and respects minLoops", async () => {
			const taskPath = join(tempDir, "TASK.md")
			writeFileSync(taskPath, "# Empty Tasks")

			let spawnCount = 0
			const restore = mockCliTools({
				onSpawn: () => {
					spawnCount++
					return {
						exited: Promise.resolve(0),
						exitCode: 0,
						stdout: createEmptyStream(),
						stderr: createEmptyStream(),
					}
				},
			})

			await runTestEffect(loop({ silent: true, minLoops: 2 }))
			restore()

			expect(spawnCount).toBe(2)
		})
	})

	describe("harness failure handling", () => {
		test("retries once on harness failure", async () => {
			const taskPath = join(tempDir, "TASK.md")
			writeFileSync(taskPath, "# Test Task\n\n- [x] Already done")

			let spawnCount = 0
			const restore = mockCliTools({
				onSpawn: () => {
					spawnCount++
					// First call fails, second succeeds
					if (spawnCount === 1) {
						return {
							exited: Promise.resolve(1),
							exitCode: 1,
							stdout: createEmptyStream(),
							stderr: createEmptyStream(),
						}
					}
					return {
						exited: Promise.resolve(0),
						exitCode: 0,
						stdout: createEmptyStream(),
						stderr: createEmptyStream(),
					}
				},
			})

			await runTestEffect(loop({ silent: true, maxLoops: 1 }))
			restore()

			// Should have called twice: first failed, retry succeeded
			expect(spawnCount).toBe(2)
		})

		test("fails after two consecutive harness failures", async () => {
			const taskPath = join(tempDir, "TASK.md")
			writeFileSync(taskPath, "# Test Task\n\n- [ ] Not done")

			const restore = mockCliTools({
				onSpawn: () => ({
					exited: Promise.resolve(1),
					exitCode: 1,
					stdout: createEmptyStream(),
					stderr: createEmptyStream(),
				}),
			})

			await expect(
				runTestEffect(loop({ silent: true, maxLoops: 1 })),
			).rejects.toThrow("Harness failed twice on iteration 1")

			restore()
		})
	})

	describe("verbose output streaming", () => {
		test("uses inherit for stdout/stderr when verbose is true", async () => {
			const taskPath = join(tempDir, "TASK.md")
			writeFileSync(taskPath, "# Test Task\n\n- [x] Already done")

			let capturedOptions: any = null
			const restore = mockCliTools({
				onSpawn: (_args, options) => {
					capturedOptions = options
					return {
						exited: Promise.resolve(0),
						exitCode: 0,
						stdout: createEmptyStream(),
						stderr: createEmptyStream(),
					}
				},
			})

			await runTestEffect(loop({ silent: true, verbose: true, maxLoops: 1 }))
			restore()

			expect(capturedOptions.stdout).toBe("inherit")
			expect(capturedOptions.stderr).toBe("inherit")
		})

		test("uses pipe for stdout/stderr when verbose is false", async () => {
			const taskPath = join(tempDir, "TASK.md")
			writeFileSync(taskPath, "# Test Task\n\n- [x] Already done")

			let capturedOptions: any = null
			const restore = mockCliTools({
				onSpawn: (_args, options) => {
					capturedOptions = options
					return {
						exited: Promise.resolve(0),
						exitCode: 0,
						stdout: createEmptyStream(),
						stderr: createEmptyStream(),
					}
				},
			})

			await runTestEffect(loop({ silent: true, verbose: false, maxLoops: 1 }))
			restore()

			expect(capturedOptions.stdout).toBe("pipe")
			expect(capturedOptions.stderr).toBe("pipe")
		})

		test("defaults to pipe (non-streaming) when verbose is not specified", async () => {
			const taskPath = join(tempDir, "TASK.md")
			writeFileSync(taskPath, "# Test Task\n\n- [x] Already done")

			let capturedOptions: any = null
			const restore = mockCliTools({
				onSpawn: (_args, options) => {
					capturedOptions = options
					return {
						exited: Promise.resolve(0),
						exitCode: 0,
						stdout: createEmptyStream(),
						stderr: createEmptyStream(),
					}
				},
			})

			await runTestEffect(loop({ silent: true, maxLoops: 1 }))
			restore()

			expect(capturedOptions.stdout).toBe("pipe")
			expect(capturedOptions.stderr).toBe("pipe")
		})
	})

	describe("extra args pass-through", () => {
		test("passes extra args to opencode", async () => {
			const taskPath = join(tempDir, "TASK.md")
			writeFileSync(taskPath, "# Test Task\n\n- [x] Already done")

			let capturedArgs: string[] = []
			const restore = mockCliTools({
				onSpawn: (args) => {
					capturedArgs = args
					return {
						exited: Promise.resolve(0),
						exitCode: 0,
						stdout: createEmptyStream(),
						stderr: createEmptyStream(),
					}
				},
			})

			await runTestEffect(
				loop({
					silent: true,
					maxLoops: 1,
					extraArgs: ["--agent", "deep"],
				}),
			)
			restore()

			expect(capturedArgs[0]).toBe("opencode")
			expect(capturedArgs[1]).toBe("run")
			expect(capturedArgs[2]).toContain("Find the next logical task")
			expect(capturedArgs.slice(-2)).toEqual(["--agent", "deep"])
		})

		test("passes extra args to claude", async () => {
			const taskPath = join(tempDir, "TASK.md")
			writeFileSync(taskPath, "# Test Task\n\n- [x] Already done")

			let capturedArgs: string[] = []
			const restore = mockCliTools({
				hasClaude: true,
				onSpawn: (args) => {
					capturedArgs = args
					return {
						exited: Promise.resolve(0),
						exitCode: 0,
						stdout: createEmptyStream(),
						stderr: createEmptyStream(),
					}
				},
			})

			await runTestEffect(
				loop({
					silent: true,
					maxLoops: 1,
					claude: true,
					extraArgs: ["--arbitrary", "switches"],
				}),
			)
			restore()

			expect(capturedArgs[0]).toBe("claude")
			expect(capturedArgs[1]).toContain("Find the next logical task")
			expect(capturedArgs.slice(-2)).toEqual(["--arbitrary", "switches"])
		})

		test("works without extra args", async () => {
			const taskPath = join(tempDir, "TASK.md")
			writeFileSync(taskPath, "# Test Task\n\n- [x] Already done")

			let capturedArgs: string[] = []
			const restore = mockCliTools({
				onSpawn: (args) => {
					capturedArgs = args
					return {
						exited: Promise.resolve(0),
						exitCode: 0,
						stdout: createEmptyStream(),
						stderr: createEmptyStream(),
					}
				},
			})

			await runTestEffect(loop({ silent: true, maxLoops: 1 }))
			restore()

			// Should just have the base args without extra args
			expect(capturedArgs).toEqual([
				"opencode",
				"run",
				expect.stringContaining("Find the next logical task"),
			])
		})
	})
})
