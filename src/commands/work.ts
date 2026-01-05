import { join } from "node:path"
import { Effect } from "effect"
import type { BaseCommandOptions } from "../utils/command"
import { FileSystemService } from "../services/FileSystemService"
import { createLoggers, ensureGitRepo } from "../utils/effect"
import { spawnProcess } from "../utils/process"
import { execvp } from "../utils/exec"

interface WorkOptions extends BaseCommandOptions {
	/**
	 * Force use of OpenCode CLI
	 */
	opencode?: boolean
	/**
	 * Force use of Claude Code CLI
	 */
	claude?: boolean
	/**
	 * Additional arguments to pass to the CLI tool
	 */
	extraArgs?: string[]
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

		// Change to git root before executing
		process.chdir(gitRoot)

		// Check for conflicting flags
		if (options.opencode && options.claude) {
			return yield* Effect.fail(
				new Error(
					"Cannot use both --opencode and --claude flags together. Choose one.",
				),
			)
		}

		// Check which CLI tool is available
		const hasOpencode = yield* Effect.tryPromise({
			try: async () => {
				const result = Bun.spawnSync(["which", "opencode"], {
					stdout: "ignore",
					stderr: "ignore",
				})
				return result.exitCode === 0
			},
			catch: () => false,
		})

		const hasClaude = yield* Effect.tryPromise({
			try: async () => {
				const result = Bun.spawnSync(["which", "claude"], {
					stdout: "ignore",
					stderr: "ignore",
				})
				return result.exitCode === 0
			},
			catch: () => false,
		})

		// Determine which CLI to use based on flags or auto-detection
		let useOpencode: boolean
		if (options.opencode) {
			if (!hasOpencode) {
				return yield* Effect.fail(
					new Error(
						"opencode CLI tool not found. Please install OpenCode or remove the --opencode flag.",
					),
				)
			}
			useOpencode = true
			verboseLog("Using opencode (explicitly requested)")
		} else if (options.claude) {
			if (!hasClaude) {
				return yield* Effect.fail(
					new Error(
						"claude CLI tool not found. Please install Claude Code or remove the --claude flag.",
					),
				)
			}
			useOpencode = false
			verboseLog("Using claude (explicitly requested)")
		} else {
			// Auto-detect
			if (!hasOpencode && !hasClaude) {
				return yield* Effect.fail(
					new Error(
						"Neither opencode nor claude CLI tool found. Please install OpenCode or Claude Code.",
					),
				)
			}
			useOpencode = hasOpencode
			verboseLog(`Using ${useOpencode ? "opencode" : "claude"} (auto-detected)`)
		}

		const cliName = useOpencode ? "opencode" : "claude"
		// Build the args array for execvp (first element should be the program name)
		// OpenCode uses: opencode --prompt "prompt"
		// Claude uses: claude "prompt"
		const baseArgs = useOpencode
			? [cliName, "--prompt", "Start the task"]
			: [cliName, "Start the task"]

		// Append extra args if provided
		const cliArgs =
			options.extraArgs && options.extraArgs.length > 0
				? [...baseArgs, ...options.extraArgs]
				: baseArgs

		if (options.extraArgs && options.extraArgs.length > 0) {
			verboseLog(
				`Running ${cliName} with extra args: ${options.extraArgs.join(" ")}`,
			)
		} else {
			verboseLog(`Running ${cliName} with task prompt...`)
		}

		// For testing, we need to use spawn instead of exec since exec never returns
		if (options._noExec) {
			// spawnProcess expects [command, ...args] where cliArgs already has the full command array
			const result = yield* spawnProcess(cliArgs, {
				cwd: gitRoot,
				stdout: "inherit",
				stderr: "inherit",
			}).pipe(
				Effect.catchAll((error) =>
					Effect.fail(
						new Error(`${cliName} exited with code ${error.exitCode}`),
					),
				),
			)

			if (result.exitCode !== 0) {
				return yield* Effect.fail(
					new Error(`${cliName} exited with code ${result.exitCode}`),
				)
			}
		} else {
			// Use execvp to replace the current process with the CLI tool
			// This will never return - the process is completely replaced
			execvp(cliName, cliArgs)
		}
	})

export const help = `
Usage: agency work [options] [-- extra-args...]

Start working on the task described in TASK.md using OpenCode or Claude Code.

This command replaces the current process with OpenCode (if available) or
Claude Code (if OpenCode is not available), launching it with a prompt to
get started on the task described in your TASK.md file.

Options:
  --opencode            Force use of OpenCode CLI
  --claude              Force use of Claude Code CLI

Pass-through Arguments:
  Use -- to pass additional arguments to the underlying CLI tool.
  Everything after -- will be forwarded to opencode or claude.

Examples:
  agency work                                  # Auto-detect (prefers opencode)
  agency work --opencode                       # Explicitly use OpenCode
  agency work --claude                         # Explicitly use Claude Code
  agency work -- --model claude-sonnet-4-20250514  # Pass custom args to CLI

Notes:
  - Requires TASK.md to exist (run 'agency task' first)
  - Requires either opencode or claude to be installed and available in PATH
  - By default, prefers opencode if both are available
  - Use --opencode or --claude to override auto-detection
  - Arguments after -- are passed directly to the underlying tool
  - Replaces the current process (agency exits and the tool takes over)
`
