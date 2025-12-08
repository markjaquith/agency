import { join } from "node:path"
import { Effect } from "effect"
import type { BaseCommandOptions } from "../utils/command"
import { FileSystemService } from "../services/FileSystemService"
import { createLoggers, ensureGitRepo } from "../utils/effect"
import { spawnProcess } from "../utils/process"
import { execvp } from "../utils/exec"

interface WorkOptions extends BaseCommandOptions {
	/**
	 * Internal option to disable exec for testing.
	 * When true, uses spawn instead of exec so tests can complete.
	 */
	_noExec?: boolean
}

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

		// Change to git root before executing
		process.chdir(gitRoot)

		// For testing, we need to use spawn instead of exec since exec never returns
		if (options._noExec) {
			const result = yield* spawnProcess(["opencode", "-p", "Start the task"], {
				cwd: gitRoot,
				stdout: "inherit",
				stderr: "inherit",
			}).pipe(
				Effect.catchAll((error) =>
					Effect.fail(new Error(`opencode exited with code ${error.exitCode}`)),
				),
			)

			if (result.exitCode !== 0) {
				return yield* Effect.fail(
					new Error(`opencode exited with code ${result.exitCode}`),
				)
			}
		} else {
			// Use execvp to replace the current process with opencode
			// This will never return - the process is completely replaced
			execvp("opencode", ["opencode", "-p", "Start the task"])
		}
	})

export const help = `
Usage: agency work [options]

Start working on the task described in TASK.md using OpenCode.

This command replaces the current process with OpenCode, launching it with
a prompt to get started on the task described in your TASK.md file.

Example:
  agency work                    # Start working on TASK.md

Notes:
  - Requires TASK.md to exist (run 'agency task' first)
  - Requires opencode to be installed and available in PATH
  - Replaces the current process (agency exits and opencode takes over)
`
