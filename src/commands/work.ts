import { join } from "node:path"
import { Effect } from "effect"
import type { BaseCommandOptions } from "../utils/command"
import { FileSystemService } from "../services/FileSystemService"
import { createLoggers, ensureGitRepo } from "../utils/effect"
import { spawnProcess } from "../utils/process"

interface WorkOptions extends BaseCommandOptions {}

export const work = (options: WorkOptions = {}) =>
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
		const result = yield* spawnProcess(
			["opencode", "-p", "Get started on the task described in TASK.md"],
			{
				cwd: gitRoot,
				stdout: "inherit",
				stderr: "inherit",
			},
		).pipe(
			Effect.catchAll((error) =>
				Effect.fail(new Error(`opencode exited with code ${error.exitCode}`)),
			),
		)

		if (result.exitCode !== 0) {
			return yield* Effect.fail(
				new Error(`opencode exited with code ${result.exitCode}`),
			)
		}
	})

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
