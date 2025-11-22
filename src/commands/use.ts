import {
	isInsideGitRepo,
	getGitRoot,
	setGitConfig,
	getGitConfig,
} from "../utils/git"
import { listTemplates } from "../utils/template"
import { prompt } from "../utils/prompt"
import highlight from "../utils/colors"

export interface UseOptions {
	template?: string
	silent?: boolean
	verbose?: boolean
}

export async function use(options: UseOptions = {}): Promise<void> {
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

	let templateName = options.template

	// If no template name provided, show interactive selection
	if (!templateName) {
		if (silent) {
			throw new Error(
				"Template name required. Use --template flag in silent mode.",
			)
		}

		const templates = await listTemplates()

		if (templates.length === 0) {
			log("No templates found in ~/.config/agency/templates/")
			log("Run 'agency task' to create a template.")
			return
		}

		// Show current template if set
		const currentTemplate = await getGitConfig("agency.template", gitRoot)
		if (currentTemplate) {
			log(`Current template: ${highlight.template(currentTemplate)}`)
		}

		log("\nAvailable templates:")
		templates.forEach((t, i) => {
			const current = t === currentTemplate ? " (current)" : ""
			log(`  ${highlight.value(i + 1)}. ${highlight.template(t)}${current}`)
		})

		const answer = await prompt("\nTemplate name (or number): ")

		if (!answer) {
			throw new Error("Template name is required.")
		}

		// Check if answer is a number (template selection)
		const num = parseInt(answer, 10)
		if (!isNaN(num) && num >= 1 && num <= templates.length) {
			templateName = templates[num - 1]!
		} else {
			templateName = answer
		}
	}

	if (!templateName) {
		throw new Error("Template name is required.")
	}

	verboseLog(`Setting template to: ${templateName}`)

	// Set the template in git config
	await setGitConfig("agency.template", templateName, gitRoot)
}

export const help = `
Usage: agency template use [template] [options]

Set the template to use for this repository.

NOTE: This command is equivalent to 'agency init'. Use 'agency init' for
      initial setup, and 'agency template use' to change templates later.

When no template name is provided, shows an interactive list of available
templates to choose from. The template name is saved to .git/config
(agency.template) and will be used by subsequent 'agency task' commands.

Arguments:
  template          Template name to use (optional, prompts if not provided)

Options:
  -h, --help        Show this help message
  -s, --silent      Suppress output messages
  -v, --verbose     Show verbose output
  -t, --template    Specify template name (same as positional argument)

Examples:
  agency template use                     # Interactive template selection
  agency template use work                # Set template to 'work'
  agency template use --template=client   # Set template to 'client'

Notes:
  - Template must exist in ~/.config/agency/templates/{name}/
  - Template name is saved to .git/config (not committed)
  - Use 'agency task' after changing template to create/update files
  - Template directory is created when you save files to it
`
