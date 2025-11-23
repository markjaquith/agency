import { Effect } from "effect"
import { TemplateService } from "../services/TemplateService"
import { FileSystemService } from "../services/FileSystemService"
import { RepositoryNotInitializedError } from "../errors"
import highlight from "../utils/colors"
import {
	runEffect,
	createLoggers,
	ensureGitRepo,
	getTemplateName,
} from "../utils/effect"

export interface ListOptions {
	silent?: boolean
	verbose?: boolean
}

function collectFilesRecursively(
	dirPath: string,
): Effect.Effect<string[], unknown> {
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
		catch: () => [],
	})
}

// Effect-based implementation
export const templateListEffect = (options: ListOptions = {}) =>
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
			catch: () => false,
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

// Backward-compatible Promise wrapper
export async function templateList(options: ListOptions = {}): Promise<void> {
	const { GitServiceLive } = await import("../services/GitServiceLive")
	const { TemplateServiceLive } = await import(
		"../services/TemplateServiceLive"
	)
	const { FileSystemServiceLive } = await import(
		"../services/FileSystemServiceLive"
	)

	await runEffect(templateListEffect(options), [
		GitServiceLive,
		TemplateServiceLive,
		FileSystemServiceLive,
	])
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
