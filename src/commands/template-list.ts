import { isInsideGitRepo, getGitRoot, getGitConfig } from "../utils/git"
import { getTemplateDir } from "../utils/template"
import { RepositoryNotInitializedError } from "../errors"
import highlight from "../utils/colors"

export interface ListOptions {
	silent?: boolean
	verbose?: boolean
}

async function collectFilesRecursively(dirPath: string): Promise<string[]> {
	const files: string[] = []

	// Use find to recursively get all files, excluding .gitkeep
	const result = Bun.spawnSync(
		["find", dirPath, "-type", "f", "!", "-name", ".gitkeep"],
		{
			stdout: "pipe",
			stderr: "ignore",
		},
	)

	const output = new TextDecoder().decode(result.stdout)
	if (output) {
		const foundFiles = output
			.trim()
			.split("\n")
			.filter((f: string) => f.length > 0)

		for (const file of foundFiles) {
			// Get relative path from template directory
			const relativePath = file.replace(dirPath + "/", "")
			if (relativePath) {
				files.push(relativePath)
			}
		}
	}

	return files.sort()
}

export async function templateList(options: ListOptions = {}): Promise<void> {
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

	// Get template name from git config
	const templateName = await getGitConfig("agency.template", gitRoot)
	if (!templateName) {
		throw new RepositoryNotInitializedError()
	}

	verboseLog(`Listing files in template: ${highlight.template(templateName)}`)

	const templateDir = getTemplateDir(templateName)

	// Check if template directory exists
	const templateDirFile = Bun.file(templateDir)
	try {
		const stat = await templateDirFile.stat()
		if (!stat || !stat.isDirectory?.()) {
			throw new Error(
				`Template directory does not exist: ${highlight.template(templateName)}`,
			)
		}
	} catch {
		throw new Error(
			`Template directory does not exist: ${highlight.template(templateName)}`,
		)
	}

	// Collect all files recursively
	const files = await collectFilesRecursively(templateDir)

	if (files.length === 0) {
		log(`Template ${highlight.template(templateName)} has no files`)
		return
	}

	for (const file of files) {
		log(highlight.file(file))
	}
}

export const help = `
Usage: agency template list [options]

List all files in the configured template directory.

This command displays all files stored in the template configured for the
current git repository.

Options:
  -h, --help        Show this help message
  -s, --silent      Suppress output messages
  -v, --verbose     Show verbose output

Example:
  agency template list                # List files in current template

Notes:
  - Requires agency.template to be set (run 'agency init' first)
  - Shows files relative to template root directory
  - Files are listed in alphabetical order
  - Template directory must exist (created when you save files)
`
