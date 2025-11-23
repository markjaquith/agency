import { join } from "node:path"
import { Effect } from "effect"
import { GitService } from "../services/GitService"
import { FileSystemService } from "../services/FileSystemService"

export interface WorkOptions {
	silent?: boolean
	verbose?: boolean
}

// Effect-based implementation
export const workEffect = (options: WorkOptions = {}) =>
	Effect.gen(function* () {
		const { silent = false, verbose = false } = options
		const verboseLog = verbose && !silent ? console.log : () => {}

		const git = yield* GitService
		const fs = yield* FileSystemService

		// Check if in a git repository
		const isGitRepo = yield* git.isInsideGitRepo(process.cwd())
		if (!isGitRepo) {
			return yield* Effect.fail(
				new Error(
					"Not in a git repository. Please run this command inside a git repo.",
				),
			)
		}

		// Get git root
		const gitRoot = yield* git.getGitRoot(process.cwd())

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

	const program = workEffect(options).pipe(
		Effect.provide(GitServiceLive),
		Effect.provide(FileSystemServiceLive),
		Effect.catchAllDefect((defect) =>
			Effect.fail(defect instanceof Error ? defect : new Error(String(defect))),
		),
	)

	await Effect.runPromise(program)
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
