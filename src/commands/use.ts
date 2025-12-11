import { Effect } from "effect"
import type { BaseCommandOptions } from "../utils/command"
import { GitService } from "../services/GitService"
import { TemplateService } from "../services/TemplateService"
import { PromptService } from "../services/PromptService"
import highlight from "../utils/colors"
import { createLoggers, ensureGitRepo } from "../utils/effect"

interface UseOptions extends BaseCommandOptions {
	template?: string
}

export const use = (options: UseOptions = {}) =>
	Effect.gen(function* () {
		const { silent = false } = options
		const { log, verboseLog } = createLoggers(options)

		const git = yield* GitService
		const templateService = yield* TemplateService
		const promptService = yield* PromptService

		const gitRoot = yield* ensureGitRepo()

		let templateName = options.template

		// If no template name provided, show interactive selection
		if (!templateName) {
			if (silent) {
				return yield* Effect.fail(
					new Error(
						"Template name required. Use --template flag in silent mode.",
					),
				)
			}

			const templates = yield* templateService.listTemplates()

			if (templates.length === 0) {
				log("No templates found in ~/.config/agency/templates/")
				log("Run 'agency task' to create a template.")
				return
			}

			// Show current template if set
			const currentTemplate = yield* git.getGitConfig(
				"agency.template",
				gitRoot,
			)
			if (currentTemplate) {
				log(`Current template: ${highlight.template(currentTemplate)}`)
			}

			templateName = yield* promptService.promptForTemplate(templates, {
				currentTemplate: currentTemplate ?? undefined,
				allowNew: false,
			})
		}

		verboseLog(`Setting template to: ${templateName}`)

		// Set the template in git config
		yield* git.setGitConfig("agency.template", templateName, gitRoot)
	})

// Help text for reference (not exported as it's handled by template command)
const help = `
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
