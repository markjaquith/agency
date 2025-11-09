import { resolve } from "path"
import { isInsideGitRepo, getGitRoot } from "../utils/git"

export interface TaskEditOptions {
	silent?: boolean
	verbose?: boolean
}

export async function taskEdit(options: TaskEditOptions = {}): Promise<void> {
	const { silent = false, verbose = false } = options
	const log = silent ? () => {} : console.log
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

	const taskFilePath = resolve(gitRoot, "TASK.md")
	verboseLog(`TASK.md path: ${taskFilePath}`)

	// Check if TASK.md exists
	const taskFile = Bun.file(taskFilePath)
	if (!(await taskFile.exists())) {
		throw new Error(
			"TASK.md not found in repository root. Run 'agency init' first to create it.",
		)
	}

	// Get editor from environment or use sensible defaults
	const editor =
		process.env.VISUAL ||
		process.env.EDITOR ||
		(process.platform === "darwin" ? "open" : "vim")

	verboseLog(`Using editor: ${editor}`)

	try {
		// Spawn the editor process
		const proc = Bun.spawn([editor, taskFilePath], {
			stdio: ["inherit", "inherit", "inherit"],
		})

		// Wait for the editor to close
		const exitCode = await proc.exited

		if (exitCode !== 0) {
			throw new Error(`Editor exited with code ${exitCode}`)
		}

		log("✓ TASK.md edited")
	} catch (err) {
		if (err instanceof Error) {
			throw new Error(`Failed to open editor: ${err.message}`)
		}
		throw err
	}
}

export const help = `
Usage: agency task edit [options]

Open TASK.md in the system editor for editing.

This command opens the TASK.md file from the repository root in your preferred
text editor. The editor is determined by the VISUAL or EDITOR environment
variables, falling back to 'open' on macOS or 'vim' on other platforms.

Options:
  -h, --help        Show this help message
  -s, --silent      Suppress output messages
  -v, --verbose     Show verbose output

Examples:
  agency task edit              # Open TASK.md in default editor
  EDITOR=nano agency task edit  # Use nano as the editor
  agency task edit --verbose    # Open with verbose output
  agency task edit --help       # Show this help message

Notes:
  - Requires TASK.md to exist (run 'agency init' first)
  - Respects VISUAL and EDITOR environment variables
  - On macOS, defaults to 'open' which uses the default app for .md files
  - On other platforms, defaults to 'vim'
  - The command waits for the editor to close before returning
`
