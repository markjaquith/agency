import { join } from "node:path"
import { Effect } from "effect"
import { GitService } from "../services/GitService"
import { FileSystemService } from "../services/FileSystemService"
import { runEffect, createLoggers, ensureGitRepo } from "../utils/effect"

export interface WorkOptions {
	silent?: boolean
	verbose?: boolean
}

// Effect-based implementation
export const workEffect = (options: WorkOptions = {}) =>
	Effect.gen(function* () {
		const { verboseLog } = createLoggers(options)

		const fs = yield* FileSystemService

		const gitRoot = yield* ensureGitRepo()

		// Check if TASK.md exists
		const taskPath = join(gitRoot, "TASK.md")
		const taskExists = yield* fs.exists(taskPath)
		if (!taskExists) {
			return yield* Effect.fail(
				new Error("TASK.md not found. Run 'agency task' first to create it."),
			)
		}

		verboseLog(`Found TASK.md at: ${taskPath}`)
		verboseLog("Running opencode with task prompt...")

		// Run opencode with the task prompt
		const proc = Bun.spawn(
			["opencode", "-p", "Get started on the task described in TASK.md"],
			{
				cwd: gitRoot,
				stdio: ["inherit", "inherit", "inherit"],
			},
		)

		const exitCode = yield* Effect.promise(() => proc.exited)

		if (exitCode !== 0) {
			return yield* Effect.fail(
				new Error(`opencode exited with code ${exitCode}`),
			)
		}
	})

// Backward-compatible Promise wrapper
export async function work(options: WorkOptions = {}): Promise<void> {
	const { GitServiceLive } = await import("../services/GitServiceLive")
	const { FileSystemServiceLive } = await import(
		"../services/FileSystemServiceLive"
	)

	await runEffect(workEffect(options), [GitServiceLive, FileSystemServiceLive])
}

export const help = `
Usage: agency work [options]

Start working on the task described in TASK.md using OpenCode.

This command launches OpenCode with a prompt to get started on the task
described in your TASK.md file.

Example:
  agency work                    # Start working on TASK.md

Notes:
  - Requires TASK.md to exist (run 'agency task' first)
  - Requires opencode to be installed and available in PATH
  - Opens an interactive OpenCode session
`
