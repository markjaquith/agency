import { basename } from "path"
import {
	isInsideGitRepo,
	getGitRoot,
	setGitConfig,
	getGitConfig,
} from "../utils/git"
import { listTemplates } from "../utils/template"
import { prompt, sanitizeTemplateName } from "../utils/prompt"
import highlight, { done } from "../utils/colors"

export interface InitOptions {
	template?: string
	silent?: boolean
	verbose?: boolean
}

export async function init(options: InitOptions = {}): Promise<void> {
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

	// Check if already initialized
	const existingTemplate = await getGitConfig("agency.template", gitRoot)
	if (existingTemplate && !options.template) {
		throw new Error(
			`Already initialized with template ${highlight.template(existingTemplate)}.\n` +
				`To change template, run: agency init --template <name>`,
		)
	}

	let templateName = options.template

	// If template name not provided, show interactive selection
	if (!templateName) {
		if (silent) {
			throw new Error(
				"Template name required. Use --template flag in silent mode.",
			)
		}

		const existingTemplates = await listTemplates()
		verboseLog(`Found ${existingTemplates.length} existing templates`)

		// Get current directory name as default suggestion
		let defaultTemplateName: string | undefined
		const dirName = basename(gitRoot)
		const sanitizedDirName = sanitizeTemplateName(dirName)

		if (sanitizedDirName && !existingTemplates.includes(sanitizedDirName)) {
			defaultTemplateName = sanitizedDirName
			verboseLog(`Suggesting default template name: ${defaultTemplateName}`)
		}

		if (existingTemplates.length > 0) {
			log("\nAvailable templates:")
			existingTemplates.forEach((t, i) => {
				log(`  ${highlight.value(i + 1)}. ${highlight.template(t)}`)
			})
			log("")
		}

		const answer = await prompt(
			existingTemplates.length > 0
				? `Template name (1-${existingTemplates.length}) or enter new name: `
				: "Template name: ",
			defaultTemplateName,
		)

		if (!answer) {
			throw new Error("Template name is required.")
		}

		// Check if answer is a number (template selection)
		const num = parseInt(answer, 10)
		if (!isNaN(num) && num >= 1 && num <= existingTemplates.length) {
			const selected = existingTemplates[num - 1]
			if (!selected) {
				throw new Error("Invalid selection")
			}
			templateName = selected
		} else {
			templateName = sanitizeTemplateName(answer)
		}

		verboseLog(`Selected template: ${templateName}`)
	}

	if (!templateName) {
		throw new Error("Template name is required.")
	}

	// Save template name to git config
	await setGitConfig("agency.template", templateName, gitRoot)
	log(
		done(
			`Initialized with template ${highlight.template(templateName)}${existingTemplate && existingTemplate !== templateName ? ` (was ${highlight.template(existingTemplate)})` : ""}`,
		),
	)

	// Note: We do NOT create the template directory here
	// It will be created when the user runs 'agency template save'
	verboseLog(
		`Template directory will be created when you save files with 'agency template save'`,
	)
}

export const help = `
Usage: agency init [options]

Initialize agency for this repository by selecting a template.

This command must be run before using other agency commands like 'agency task'.
It saves your template selection to .git/config (not committed to the repository).

On first run, you'll be prompted to either:
  - Select an existing template from your ~/.config/agency/templates/
  - Create a new template by entering a new name

If no templates exist, the default suggestion is the current directory name.

The template directory itself is only created when you actually save files to it
using 'agency template save'.

Options:
  -t, --template    Specify template name (skips interactive prompt)

Examples:
  agency init                    # Interactive template selection
  agency init --template work    # Set template to 'work'

Notes:
  - Template name is saved to .git/config (agency.template)
  - Template directory is NOT created until 'agency template save' is used
  - To change template later, run 'agency init --template <name>'
  - Run 'agency task' after initialization to create template files
`
