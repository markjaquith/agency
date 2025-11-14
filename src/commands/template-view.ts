import { resolve } from "path"
import { isInsideGitRepo, getGitRoot, getGitConfig } from "../utils/git"
import { getTemplateDir } from "../utils/template"
import highlight from "../utils/colors"

export interface ViewOptions {
	file?: string
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

export async function templateView(options: ViewOptions = {}): Promise<void> {
	const { file: fileToView, silent = false, verbose = false } = options
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

	if (!fileToView) {
		throw new Error("File path is required. Usage: agency template view <file>")
	}

	verboseLog(
		`Viewing ${highlight.file(fileToView)} from ${highlight.template(templateName)} template`,
	)

	const templateDir = getTemplateDir(templateName)
	const templateFilePath = resolve(templateDir, fileToView)

	// Check if file exists
	if (!(await fileExists(templateFilePath))) {
		throw new Error(
			`File ${highlight.file(fileToView)} does not exist in template ${highlight.template(templateName)}`,
		)
	}

	try {
		// Read and display the file
		const file = Bun.file(templateFilePath)
		const content = await file.text()
		console.log(content)
	} catch (err) {
		// Re-throw errors for CLI handler to display
		throw err
	}
}

export const help = `
Usage: agency template view <file> [options]

View the contents of a file in the configured template directory.

This command displays the contents of a file stored in the template 
configured for the current git repository.

Arguments:
  <file>            File path to view (relative to template root)

Options:
  -h, --help        Show this help message
  -s, --silent      Suppress verbose messages (file content still shown)
  -v, --verbose     Show verbose output

Examples:
  agency template view AGENTS.md         # View AGENTS.md from template
  agency template view docs/README.md    # View file in subdirectory

Notes:
  - Requires agency.template to be set (run 'agency task' first)
  - File path is relative to template root directory
  - File content is displayed directly to stdout
`
