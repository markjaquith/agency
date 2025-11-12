import { resolve, join, dirname, basename } from "path"
import { isInsideGitRepo, getGitRoot, getGitConfig } from "../utils/git"
import { getTemplateDir } from "../utils/template"
import highlight from "../utils/colors"

export interface SaveOptions {
	files?: string[]
	silent?: boolean
	verbose?: boolean
}

async function isDirectory(filePath: string): Promise<boolean> {
	try {
		const file = Bun.file(filePath)
		const stat = await file.stat()
		return stat?.isDirectory?.() ?? false
	} catch {
		return false
	}
}

async function collectFilesRecursively(
	dirPath: string,
	gitRoot: string,
): Promise<string[]> {
	const files: string[] = []

	// Use find to recursively get all files
	const result = Bun.spawnSync(["find", dirPath, "-type", "f"], {
		stdout: "pipe",
		stderr: "ignore",
	})

	const output = new TextDecoder().decode(result.stdout)
	if (output) {
		const foundFiles = output
			.trim()
			.split("\n")
			.filter((f: string) => f.length > 0)

		for (const file of foundFiles) {
			// Get relative path from git root
			const relativePath = file.replace(gitRoot + "/", "")
			if (relativePath) {
				files.push(relativePath)
			}
		}
	}

	return files
}

export async function save(options: SaveOptions = {}): Promise<void> {
	const { files: filesToSave = [], silent = false, verbose = false } = options
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

	// Get template name from git config
	const templateName = await getGitConfig("agency.template", gitRoot)
	if (!templateName) {
		throw new Error(
			"No template configured for this repository. Run 'agency task' first.",
		)
	}

	verboseLog(`Saving to template: ${highlight.template(templateName)}`)

	const templateDir = getTemplateDir(templateName)

	// Determine which files to save
	let filesToProcess: string[] = []

	if (filesToSave.length > 0) {
		// Process provided file/dir names
		for (const fileOrDir of filesToSave) {
			const fullPath = resolve(gitRoot, fileOrDir)
			const isDir = await isDirectory(fullPath)

			if (isDir) {
				// Recursively collect files from directory
				const collected = await collectFilesRecursively(fullPath, gitRoot)
				filesToProcess.push(...collected)
			} else {
				// Add file path relative to git root
				const relativePath = fileOrDir.startsWith(gitRoot)
					? fileOrDir.replace(gitRoot + "/", "")
					: fileOrDir
				filesToProcess.push(relativePath)
			}
		}
	} else {
		throw new Error(
			"No files specified. Usage: agency save <file|dir> [file|dir ...]",
		)
	}

	try {
		// Save each file
		for (const filePath of filesToProcess) {
			const sourceFilePath = resolve(gitRoot, filePath)
			const sourceFile = Bun.file(sourceFilePath)

			if (!(await sourceFile.exists())) {
				verboseLog(`Skipping ${filePath} (does not exist)`)
				continue
			}

			const content = await sourceFile.text()

			// Validate TASK.md files contain the {task} placeholder
			const fileName = basename(filePath)
			if (fileName === "TASK.md") {
				if (!content.includes("{task}")) {
					throw new Error(
						`Cannot save ${filePath}: TASK.md files must contain the {task} placeholder to be saved as a template. ` +
							`This prevents accidentally saving a specific task instead of a task template.`,
					)
				}
			}

			const templateFilePath = join(templateDir, filePath)

			// Ensure directory exists
			const dir = dirname(templateFilePath)
			await Bun.write(dir + "/.gitkeep", "")

			await Bun.write(templateFilePath, content)
			log(
				`✓ Saved ${highlight.file(filePath)} to ${highlight.template(templateName)} template`,
			)
		}
	} catch (err) {
		// Re-throw errors for CLI handler to display
		throw err
	}
}

export const help = `
Usage: agency save <file|dir> [file|dir ...] [options]

Save specified files or directories to the configured template.

This command copies files and directories from the current git repository to 
the template directory configured in .git/config (agency.template). Directories
are saved recursively.

Arguments:
  <file|dir>        File or directory path to save (relative to git root)
  [file|dir ...]    Additional files or directories to save

Options:
  -h, --help        Show this help message
  -s, --silent      Suppress output messages
  -v, --verbose     Show verbose output

Examples:
   agency save AGENTS.md              # Save specific file
  agency save .config                # Save entire directory
  agency save src/                   # Save src directory to template
  agency save AGENTS.md docs/        # Save file and directory
  agency save --verbose              # Save with verbose output
  agency save --help                 # Show this help message

Notes:
  - Requires agency.template to be set (run 'agency task' first)
  - At least one file or directory must be specified
  - Files are saved to ~/.config/agency/templates/{template-name}/
  - Existing template files will be overwritten
  - Directory structure is preserved in the template
  - TASK.md files must contain the {task} placeholder to prevent saving
    specific tasks instead of task templates
`
