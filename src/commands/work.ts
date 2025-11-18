import { existsSync } from "node:fs"
import { join } from "node:path"
import { isInsideGitRepo, getGitRoot } from "../utils/git"

export interface WorkOptions {
	silent?: boolean
	verbose?: boolean
}

export async function work(options: WorkOptions = {}): Promise<void> {
	const { silent = false, verbose = false } = options
	const verboseLog = verbose && !silent ? console.log : () => {}

	// Check if in a git repository
	if (!(await isInsideGitRepo(process.cwd()))) {
		throw new Error(
			"Not in a git repository. Please run this command inside a git repo.",
		)
	}

	const gitRoot = await getGitRoot(process.cwd())
	if (!gitRoot) {
		throw new Error("Failed to determine the root of the git repository.")
	}

	// Check if TASK.md exists
	const taskPath = join(gitRoot, "TASK.md")
	if (!existsSync(taskPath)) {
		throw new Error("TASK.md not found. Run 'agency task' first to create it.")
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

	const exitCode = await proc.exited

	if (exitCode !== 0) {
		throw new Error(`opencode exited with code ${exitCode}`)
	}
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
