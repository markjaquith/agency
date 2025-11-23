import { Effect } from "effect"
import { createCommand, type BaseCommandOptions } from "../utils/command"
import { TemplateService } from "../services/TemplateService"
import { FileSystemService } from "../services/FileSystemService"
import { RepositoryNotInitializedError } from "../errors"
import highlight from "../utils/colors"
import { createLoggers, ensureGitRepo, getTemplateName } from "../utils/effect"

interface ListOptions extends BaseCommandOptions {}

function collectFilesRecursively(
	dirPath: string,
): Effect.Effect<string[], Error> {
	return Effect.tryPromise({
		try: async () => {
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
		},
		catch: (error) => new Error(`Failed to collect files: ${error}`),
	})
}

// Effect-based implementation
const templateListEffect = (options: ListOptions = {}) =>
	Effect.gen(function* () {
		const { log, verboseLog } = createLoggers(options)

		const templateService = yield* TemplateService

		const gitRoot = yield* ensureGitRepo()

		// Get template name from git config
		const templateName = yield* getTemplateName(gitRoot)
		if (!templateName) {
			return yield* Effect.fail(new RepositoryNotInitializedError())
		}

		verboseLog(`Listing files in template: ${highlight.template(templateName)}`)

		// Get template directory
		const templateDir = yield* templateService.getTemplateDir(templateName)

		// Check if template directory exists and is a directory
		const isDirectory = yield* Effect.tryPromise({
			try: async () => {
				const file = Bun.file(templateDir)
				const stat = await file.stat()
				return stat?.isDirectory?.() ?? false
			},
			catch: (error) =>
				new Error(`Failed to check template directory: ${error}`),
		})
		if (!isDirectory) {
			return yield* Effect.fail(
				new Error(
					`Template directory does not exist: ${highlight.template(templateName)}`,
				),
			)
		}

		// Collect all files recursively
		const files = yield* collectFilesRecursively(templateDir)

		if (files.length === 0) {
			log(`Template ${highlight.template(templateName)} has no files`)
			return
		}

		for (const file of files) {
			log(highlight.file(file))
		}
	})

const helpText = `
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

export const { execute: templateList } = createCommand<ListOptions>({
	name: "template-list",
	services: ["git", "template", "filesystem"],
	effect: templateListEffect,
})
