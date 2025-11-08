import { resolve, join, basename } from "path"
import {
	isInsideGitRepo,
	getGitRoot,
	isGitRoot,
	getGitConfig,
	setGitConfig,
} from "../utils/git"
import { getConfigDir } from "../config"
import { MANAGED_FILES } from "../types"
import { prompt, sanitizeTemplateName } from "../utils/prompt"
import {
	getTemplateDir,
	createTemplateDir,
	templateExists,
} from "../utils/template"

export interface InitOptions {
	path?: string
	silent?: boolean
	verbose?: boolean
	template?: string
	task?: string
}

export async function init(options: InitOptions = {}): Promise<void> {
	const { silent = false, verbose = false } = options
	const log = silent ? () => {} : console.log
	const verboseLog = verbose && !silent ? console.log : () => {}

	let targetPath: string

	if (options.path) {
		// If path is provided, validate it's a git repository root
		targetPath = resolve(options.path)

		if (!(await isGitRoot(targetPath))) {
			throw new Error(
				"The specified path is not the root of a git repository. Please provide a path to the top-level directory of a git checkout.",
			)
		}
	} else {
		// If no path provided, use git root of current directory
		if (!(await isInsideGitRepo(process.cwd()))) {
			throw new Error(
				"Not in a git repository. Please run this command inside a git repo.",
			)
		}

		const gitRoot = await getGitRoot(process.cwd())
		if (!gitRoot) {
			throw new Error("Failed to determine the root of the git repository.")
		}

		targetPath = gitRoot
	}

	const configDir = getConfigDir()

	try {
		// Get or prompt for template name
		let templateName =
			options.template || (await getGitConfig("agency.template", targetPath))
		let needsSaveToConfig = false

		if (!templateName) {
			// Prompt for template name if not in silent mode
			if (silent) {
				throw new Error(
					"No template configured. Run without --silent to configure, or use --template flag.",
				)
			}

			log("No template configured for this repository.")

			// Suggest directory name as default if no template exists with that name
			let defaultTemplateName: string | undefined
			const dirName = basename(targetPath)
			const sanitizedDirName = sanitizeTemplateName(dirName)

			if (sanitizedDirName && !(await templateExists(sanitizedDirName))) {
				defaultTemplateName = sanitizedDirName
				verboseLog(`Suggesting default template name: ${defaultTemplateName}`)
			}

			const answer = await prompt("Template name: ", defaultTemplateName)

			if (!answer) {
				throw new Error("Template name is required.")
			}

			templateName = sanitizeTemplateName(answer)
			verboseLog(`Sanitized template name: ${templateName}`)
			needsSaveToConfig = true
		} else if (options.template) {
			// Template was provided via option, not from git config
			const existingTemplate = await getGitConfig("agency.template", targetPath)
			if (existingTemplate !== options.template) {
				needsSaveToConfig = true
			}
			verboseLog(`Using template: ${templateName}`)
		} else {
			verboseLog(`Using template: ${templateName}`)
		}

		// Create template directory if it doesn't exist
		const templateDir = getTemplateDir(templateName)
		await createTemplateDir(templateName)

		// Check if template is new (doesn't have any files yet)
		const templateAgents = Bun.file(join(templateDir, "AGENTS.md"))
		if (!(await templateAgents.exists())) {
			log(`✓ Created template '${templateName}'`)

			// Copy default content to template for each managed file
			for (const managedFile of MANAGED_FILES) {
				const templateFilePath = join(templateDir, managedFile.name)
				const templateFile = Bun.file(templateFilePath)

				if (!(await templateFile.exists())) {
					const defaultContent = managedFile.defaultContent ?? ""
					await Bun.write(templateFilePath, defaultContent)
					verboseLog(`Created ${templateFilePath} with default content`)
				}
			}
		}

		// Save template name to git config if needed
		if (needsSaveToConfig) {
			await setGitConfig("agency.template", templateName, targetPath)
			log(`✓ Set agency.template = ${templateName}`)
		}

		// Prompt for task if TASK.md will be created
		let taskDescription: string | undefined
		const taskMdPath = resolve(targetPath, "TASK.md")
		const taskMdFile = Bun.file(taskMdPath)
		if (!(await taskMdFile.exists())) {
			if (options.task) {
				taskDescription = options.task
				verboseLog(`Using task from option: ${taskDescription}`)
			} else if (!silent) {
				taskDescription = await prompt("Task description: ")
				if (!taskDescription) {
					log(
						"ⓘ Skipping task description (TASK.md will use default placeholder)",
					)
					taskDescription = undefined
				}
			}
		}

		// Process each managed file
		for (const managedFile of MANAGED_FILES) {
			const targetFilePath = resolve(targetPath, managedFile.name)
			const targetFile = Bun.file(targetFilePath)

			if (await targetFile.exists()) {
				log(`ⓘ ${managedFile.name} already exists at ${targetFilePath}`)
				continue
			}

			let content: string

			// Try template directory first
			const templateFilePath = join(
				getTemplateDir(templateName),
				managedFile.name,
			)
			const templateFile = Bun.file(templateFilePath)

			if (await templateFile.exists()) {
				content = await templateFile.text()
				verboseLog(`Using template file from ${templateFilePath}`)
			} else {
				// Fall back to config directory root (backward compatibility)
				const sourceFilePath = join(configDir, managedFile.name)
				const sourceFile = Bun.file(sourceFilePath)

				if (await sourceFile.exists()) {
					content = await sourceFile.text()
					verboseLog(`Using source file from ${sourceFilePath}`)
				} else {
					// Use default content
					content = managedFile.defaultContent ?? ""
					verboseLog(`Using default content for ${managedFile.name}`)
				}
			}

			// Replace {task} placeholder in TASK.md if task description was provided
			if (managedFile.name === "TASK.md" && taskDescription) {
				content = content.replace("{task}", taskDescription)
				verboseLog(`Replaced {task} placeholder with: ${taskDescription}`)
			}

			await Bun.write(targetFilePath, content)
			log(`✓ Created ${managedFile.name} from '${templateName}' template`)
		}
	} catch (err) {
		// Re-throw errors for CLI handler to display
		throw err
	}
}

export const help = `
Usage: agency init [path] [options]

Initialize AGENTS.md file in a git repository using templates.

When no path is provided, initializes files at the root of the current git
repository. When a path is provided, it must be the root directory of a git
repository.

On first run in a repository, you'll be prompted for a template name. This
creates a template directory at ~/.config/agency/templates/{name}/ and saves
the template name to .git/config for future use.

Arguments:
  path              Path to git repository root (defaults to current repo root)

Options:
  -h, --help        Show this help message
  -s, --silent      Suppress output messages
  -v, --verbose     Show verbose output
  -t, --template    Specify template name (skips prompt)

Examples:
  agency init                    # Initialize with interactive template prompt
  agency init --template=work    # Initialize with specific template
  agency init ./my-project       # Initialize in specified git repo root
  agency init --verbose          # Initialize with verbose output
  agency init --help             # Show this help message

Template Workflow:
  1. First run: Prompted for template name (e.g., "work")
  2. Template directory created at ~/.config/agency/templates/work/
  3. Template name saved to .git/config (agency.template = work)
  4. Subsequent runs: Automatically uses saved template
  5. Use 'agency save' to update template with local changes

Notes:
  - Files are created at the git repository root, not the current directory
  - If files already exist, they will not be overwritten
  - The specified path (if provided) must be a git repository root
  - Templates are stored per-repository in .git/config (not committed)
  - Use --template flag to override saved template or skip prompt
`
