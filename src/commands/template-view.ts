import { resolve } from "path"
import { Effect } from "effect"
import { createCommand, type BaseCommandOptions } from "../utils/command"
import { TemplateService } from "../services/TemplateService"
import { FileSystemService } from "../services/FileSystemService"
import { RepositoryNotInitializedError } from "../errors"
import highlight from "../utils/colors"
import { createLoggers, ensureGitRepo, getTemplateName } from "../utils/effect"

interface ViewOptions extends BaseCommandOptions {
	file?: string
}

// Effect-based implementation
const templateViewEffect = (options: ViewOptions = {}) =>
	Effect.gen(function* () {
		const { file: fileToView, silent = false } = options
		const { verboseLog } = createLoggers(options)

		const templateService = yield* TemplateService
		const fs = yield* FileSystemService

		const gitRoot = yield* ensureGitRepo()

		// Get template name from git config
		const templateName = yield* getTemplateName(gitRoot)
		if (!templateName) {
			return yield* Effect.fail(new RepositoryNotInitializedError())
		}

		if (!fileToView) {
			return yield* Effect.fail(
				new Error("File path is required. Usage: agency template view <file>"),
			)
		}

		verboseLog(
			`Viewing ${highlight.file(fileToView)} from ${highlight.template(templateName)} template`,
		)

		// Get template directory
		const templateDir = yield* templateService.getTemplateDir(templateName)
		const templateFilePath = resolve(templateDir, fileToView)

		// Check if file exists
		const exists = yield* fs.exists(templateFilePath)
		if (!exists) {
			return yield* Effect.fail(
				new Error(
					`File ${highlight.file(fileToView)} does not exist in template ${highlight.template(templateName)}`,
				),
			)
		}

		// Read and display the file
		const content = yield* fs.readFile(templateFilePath)
		if (!silent) {
			console.log(content)
		}
	})

const helpText = `
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
  - Requires agency.template to be set (run 'agency init' first)
  - File path is relative to template root directory
  - File content is displayed directly to stdout
`

export const { execute: templateView } = createCommand<ViewOptions>({
	name: "template-view",
	services: ["git", "template", "filesystem"],
	effect: templateViewEffect,
})
