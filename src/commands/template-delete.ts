import { resolve } from "path"
import { rm } from "node:fs/promises"
import { isInsideGitRepo, getGitRoot, getGitConfig } from "../utils/git"
import { getTemplateDir } from "../utils/template"
import highlight, { done } from "../utils/colors"

export interface DeleteOptions {
	files?: string[]
	silent?: boolean
	verbose?: boolean
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		const file = Bun.file(filePath)
		return await file.exists()
	} catch {
		return false
	}
}

export async function templateDelete(
	options: DeleteOptions = {},
): Promise<void> {
	const { files: filesToDelete = [], silent = false, verbose = false } = options
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

	if (filesToDelete.length === 0) {
		throw new Error(
			"No files specified. Usage: agency template delete <file> [file ...]",
		)
	}

	verboseLog(`Deleting from template: ${highlight.template(templateName)}`)

	const templateDir = getTemplateDir(templateName)

	try {
		// Delete each file
		for (const filePath of filesToDelete) {
			const templateFilePath = resolve(templateDir, filePath)

			// Check if file exists
			if (!(await fileExists(templateFilePath))) {
				verboseLog(`Skipping ${filePath} (does not exist in template)`)
				continue
			}

			// Delete the file
			await rm(templateFilePath, { recursive: true, force: true })
			log(
				done(
					`Deleted ${highlight.file(filePath)} from ${highlight.template(templateName)} template`,
				),
			)
		}
	} catch (err) {
		// Re-throw errors for CLI handler to display
		throw err
	}
}

export const help = `
Usage: agency template delete <file> [file ...] [options]

Delete specified files from the configured template directory.

This command removes files from the template directory configured in 
.git/config (agency.template).

Arguments:
  <file>            File path to delete (relative to template root)
  [file ...]        Additional files to delete

Options:
  -h, --help        Show this help message
  -s, --silent      Suppress output messages
  -v, --verbose     Show verbose output

Examples:
  agency template delete AGENTS.md           # Delete specific file
  agency template delete docs/ src/          # Delete directories
  agency template delete file1 file2 file3   # Delete multiple files

Notes:
  - Requires agency.template to be set (run 'agency task' first)
  - At least one file must be specified
  - Files are deleted from ~/.config/agency/templates/{template-name}/
  - Non-existent files are skipped with a warning in verbose mode
  - Directories are deleted recursively
`
