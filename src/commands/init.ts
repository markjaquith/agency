import { basename } from "path"
import { Effect } from "effect"
import type { BaseCommandOptions } from "../utils/command"
import { GitService } from "../services/GitService"
import { PromptService } from "../services/PromptService"
import { TemplateService } from "../services/TemplateService"
import highlight, { done } from "../utils/colors"
import { createLoggers, ensureGitRepo, getTemplateName } from "../utils/effect"

interface InitOptions extends BaseCommandOptions {
	template?: string
}

export const init = (options: InitOptions = {}) =>
	Effect.gen(function* () {
		const { silent = false, cwd } = options
		const { log, verboseLog } = createLoggers(options)

		const git = yield* GitService
		const promptService = yield* PromptService
		const templateService = yield* TemplateService

		const gitRoot = yield* ensureGitRepo(cwd)

		// Check if already initialized
		const existingTemplate = yield* getTemplateName(gitRoot)
		if (existingTemplate && !options.template) {
			return yield* Effect.fail(
				new Error(
					`Already initialized with template ${highlight.template(existingTemplate)}.\n` +
						`To change template, run: agency init --template <name>`,
				),
			)
		}

		let templateName = options.template

		// If template name not provided, show interactive selection
		if (!templateName) {
			if (silent) {
				return yield* Effect.fail(
					new Error(
						"Template name required. Use --template flag in silent mode.",
					),
				)
			}

			const existingTemplates = yield* templateService.listTemplates()
			verboseLog(`Found ${existingTemplates.length} existing templates`)

			// Get current directory name as default suggestion
			let defaultTemplateName: string | undefined
			const dirName = basename(gitRoot)
			const sanitizedDirName =
				yield* promptService.sanitizeTemplateName(dirName)

			if (sanitizedDirName && !existingTemplates.includes(sanitizedDirName)) {
				defaultTemplateName = sanitizedDirName
				verboseLog(`Suggesting default template name: ${defaultTemplateName}`)
			}

			const selectedName = yield* promptService.promptForTemplate(
				existingTemplates,
				{
					defaultValue: defaultTemplateName,
					allowNew: true,
				},
			)

			// If selected from list, use as-is; otherwise sanitize new name
			if (existingTemplates.includes(selectedName)) {
				templateName = selectedName
			} else {
				templateName = yield* promptService.sanitizeTemplateName(selectedName)
			}

			verboseLog(`Selected template: ${templateName}`)
		}

		if (!templateName) {
			return yield* Effect.fail(new Error("Template name is required."))
		}

		// Resolve and save default remote (with smart precedence)
		const remote = yield* git
			.resolveRemote(gitRoot)
			.pipe(Effect.catchAll(() => Effect.succeed(null)))

		if (remote) {
			yield* git.setRemoteConfig(remote, gitRoot)
			verboseLog(`Detected and saved remote: ${remote}`)
		} else {
			verboseLog("No remote detected - skip remote configuration")
		}

		// Save template name to git config
		yield* git.setGitConfig("agency.template", templateName, gitRoot)
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
	})

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
