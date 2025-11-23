import { resolve } from "path"
import { rm } from "node:fs/promises"
import { Effect } from "effect"
import { createCommand, type BaseCommandOptions } from "../utils/command"
import { TemplateService } from "../services/TemplateService"
import { FileSystemService } from "../services/FileSystemService"
import { RepositoryNotInitializedError } from "../errors"
import highlight, { done } from "../utils/colors"
import { createLoggers, ensureGitRepo, getTemplateName } from "../utils/effect"

export interface DeleteOptions extends BaseCommandOptions {
	files?: string[]
}

// Effect-based implementation
export const templateDeleteEffect = (options: DeleteOptions = {}) =>
	Effect.gen(function* () {
		const { files: filesToDelete = [] } = options
		const { log, verboseLog } = createLoggers(options)

		const templateService = yield* TemplateService
		const fs = yield* FileSystemService

		const gitRoot = yield* ensureGitRepo()

		// Get template name from git config
		const templateName = yield* getTemplateName(gitRoot)
		if (!templateName) {
			return yield* Effect.fail(new RepositoryNotInitializedError())
		}

		if (filesToDelete.length === 0) {
			return yield* Effect.fail(
				new Error(
					"No files specified. Usage: agency template delete <file> [file ...]",
				),
			)
		}

		verboseLog(`Deleting from template: ${highlight.template(templateName)}`)

		// Get template directory
		const templateDir = yield* templateService.getTemplateDir(templateName)

		// Delete each file
		for (const filePath of filesToDelete) {
			const templateFilePath = resolve(templateDir, filePath)

			// Check if file exists
			const exists = yield* fs.exists(templateFilePath)
			if (!exists) {
				verboseLog(`Skipping ${filePath} (does not exist in template)`)
				continue
			}

			// Delete the file/directory
			yield* Effect.tryPromise({
				try: () => rm(templateFilePath, { recursive: true, force: true }),
				catch: (error) => new Error(`Failed to delete ${filePath}: ${error}`),
			})

			log(
				done(
					`Deleted ${highlight.file(filePath)} from ${highlight.template(templateName)} template`,
				),
			)
		}
	})

const helpText = `
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
  - Requires agency.template to be set (run 'agency init' first)
  - At least one file must be specified
  - Files are deleted from ~/.config/agency/templates/{template-name}/
  - Non-existent files are skipped with a warning in verbose mode
  - Directories are deleted recursively
`

export const {
	effect,
	execute: templateDelete,
	help,
} = createCommand<DeleteOptions>({
	name: "template-delete",
	services: ["git", "template", "filesystem"],
	effect: templateDeleteEffect,
	help: helpText,
})
