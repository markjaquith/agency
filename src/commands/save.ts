import { resolve, join, dirname, basename } from "path"
import { Effect } from "effect"
import { GitService } from "../services/GitService"
import { TemplateService } from "../services/TemplateService"
import { FileSystemService } from "../services/FileSystemService"
import { RepositoryNotInitializedError } from "../errors"
import highlight, { done } from "../utils/colors"

export interface SaveOptions {
	files?: string[]
	silent?: boolean
	verbose?: boolean
}

function isDirectory(filePath: string): Effect.Effect<boolean, unknown> {
	return Effect.tryPromise({
		try: async () => {
			try {
				const file = Bun.file(filePath)
				const stat = await file.stat()
				return stat?.isDirectory?.() ?? false
			} catch {
				return false
			}
		},
		catch: () => false,
	})
}

function collectFilesRecursively(
	dirPath: string,
	gitRoot: string,
): Effect.Effect<string[], unknown> {
	return Effect.tryPromise({
		try: async () => {
			const files: string[] = []

			// Use find to recursively get all files
			const result = Bun.spawnSync(["find", dirPath, "-type", "f"], {
				stdout: "pipe",
				stderr: "ignore",
			})

			const output = new TextDecoder().decode(result.stdout)
			if (output) {
				const foundFiles = output
					.trim()
					.split("\n")
					.filter((f: string) => f.length > 0)

				for (const file of foundFiles) {
					// Get relative path from git root
					const relativePath = file.replace(gitRoot + "/", "")
					if (relativePath) {
						files.push(relativePath)
					}
				}
			}

			return files
		},
		catch: () => [],
	})
}

// Effect-based implementation
export const saveEffect = (options: SaveOptions = {}) =>
	Effect.gen(function* () {
		const { files: filesToSave = [], silent = false, verbose = false } = options
		const log = silent ? () => {} : console.log
		const verboseLog = verbose && !silent ? console.log : () => {}

		const git = yield* GitService
		const templateService = yield* TemplateService
		const fs = yield* FileSystemService

		// Check if in a git repository
		const isGitRepo = yield* git.isInsideGitRepo(process.cwd())
		if (!isGitRepo) {
			return yield* Effect.fail(
				new Error(
					"Not in a git repository. Please run this command inside a git repo.",
				),
			)
		}

		// Get git root
		const gitRoot = yield* git.getGitRoot(process.cwd())

		// Get template name from git config
		const templateName = yield* git.getGitConfig("agency.template", gitRoot)
		if (!templateName) {
			return yield* Effect.fail(new RepositoryNotInitializedError())
		}

		verboseLog(`Saving to template: ${highlight.template(templateName)}`)

		// Get template directory
		const templateDir = yield* templateService.getTemplateDir(templateName)

		// Create template directory if it doesn't exist
		yield* templateService.createTemplateDir(templateName)
		verboseLog(`Ensured template directory exists: ${templateDir}`)

		// Determine which files to save
		let filesToProcess: string[] = []

		if (filesToSave.length > 0) {
			// Process provided file/dir names
			for (const fileOrDir of filesToSave) {
				const fullPath = resolve(gitRoot, fileOrDir)
				const isDir = yield* isDirectory(fullPath)

				if (isDir) {
					// Recursively collect files from directory
					const collected = yield* collectFilesRecursively(fullPath, gitRoot)
					filesToProcess.push(...collected)
				} else {
					// Add file path relative to git root
					const relativePath = fileOrDir.startsWith(gitRoot)
						? fileOrDir.replace(gitRoot + "/", "")
						: fileOrDir
					filesToProcess.push(relativePath)
				}
			}
		} else {
			return yield* Effect.fail(
				new Error(
					"No files specified. Usage: agency save <file|dir> [file|dir ...]",
				),
			)
		}

		// Save each file
		for (const filePath of filesToProcess) {
			const sourceFilePath = resolve(gitRoot, filePath)

			// Check if file exists
			const exists = yield* fs.exists(sourceFilePath)
			if (!exists) {
				verboseLog(`Skipping ${filePath} (does not exist)`)
				continue
			}

			// Refuse to save TASK.md files - agency itself must control these
			const fileName = basename(filePath)
			if (fileName === "TASK.md") {
				return yield* Effect.fail(
					new Error(
						`Cannot save ${filePath}: TASK.md files cannot be saved to templates. ` +
							`Agency itself must control the creation of TASK.md files.`,
					),
				)
			}

			// Read content
			const content = yield* fs.readFile(sourceFilePath)

			const templateFilePath = join(templateDir, filePath)

			// Ensure directory exists
			const dir = dirname(templateFilePath)
			yield* fs.createDirectory(dir)

			// Write to template
			yield* fs.writeFile(templateFilePath, content)
			log(
				done(
					`Saved ${highlight.file(filePath)} to ${highlight.template(templateName)} template`,
				),
			)
		}
	})

// Backward-compatible Promise wrapper
export async function save(options: SaveOptions = {}): Promise<void> {
	const { GitServiceLive } = await import("../services/GitServiceLive")
	const { TemplateServiceLive } = await import(
		"../services/TemplateServiceLive"
	)
	const { FileSystemServiceLive } = await import(
		"../services/FileSystemServiceLive"
	)

	const program = saveEffect(options).pipe(
		Effect.provide(GitServiceLive),
		Effect.provide(TemplateServiceLive),
		Effect.provide(FileSystemServiceLive),
		Effect.catchAllDefect((defect) =>
			Effect.fail(defect instanceof Error ? defect : new Error(String(defect))),
		),
	)

	await Effect.runPromise(program)
}

export const help = `
Usage: agency save <file|dir> [file|dir ...] [options]

Save specified files or directories to the configured template.

This command copies files and directories from the current git repository to 
the template directory configured in .git/config (agency.template). Directories
are saved recursively.

Arguments:
  <file|dir>        File or directory path to save (relative to git root)
  [file|dir ...]    Additional files or directories to save

Options:
  -h, --help        Show this help message
  -s, --silent      Suppress output messages
  -v, --verbose     Show verbose output

Examples:
   agency save AGENTS.md              # Save specific file
   agency save .config                # Save entire directory
   agency save src/                   # Save src directory to template
   agency save AGENTS.md docs/        # Save file and directory
   agency save --verbose              # Save with verbose output
   agency save --help                 # Show this help message

Notes:
  - Requires agency.template to be set (run 'agency init' first)
  - At least one file or directory must be specified
  - Files are saved to ~/.config/agency/templates/{template-name}/
  - Template directory is created automatically if it doesn't exist
  - Existing template files will be overwritten
  - Directory structure is preserved in the template
  - TASK.md files cannot be saved - agency controls their creation
`
