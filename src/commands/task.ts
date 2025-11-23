import { resolve, join } from "path"
import { Effect } from "effect"
import { createCommand, type BaseCommandOptions } from "../utils/command"
import { GitService } from "../services/GitService"
import { FileSystemService } from "../services/FileSystemService"
import { PromptService } from "../services/PromptService"
import { TemplateService } from "../services/TemplateService"
import { initializeManagedFiles, writeAgencyMetadata } from "../types"
import { RepositoryNotInitializedError } from "../errors"
import highlight, { done, info, plural } from "../utils/colors"
import { createLoggers, ensureGitRepo, getTemplateName } from "../utils/effect"

interface TaskOptions extends BaseCommandOptions {
	path?: string
	task?: string
	branch?: string
}

interface TaskEditOptions extends BaseCommandOptions {}

// Effect-based implementation
const taskEffect = (options: TaskOptions = {}) =>
	Effect.gen(function* () {
		const { silent = false, verbose = false } = options
		const { log, verboseLog } = createLoggers(options)

		const git = yield* GitService
		const fs = yield* FileSystemService
		const promptService = yield* PromptService
		const templateService = yield* TemplateService

		// Determine target path
		let targetPath: string

		if (options.path) {
			// If path is provided, validate it's a git repository root
			targetPath = resolve(options.path)

			const isRoot = yield* git.isGitRoot(targetPath)
			if (!isRoot) {
				return yield* Effect.fail(
					new Error(
						"The specified path is not the root of a git repository. Please provide a path to the top-level directory of a git checkout.",
					),
				)
			}
		} else {
			// If no path provided, use git root of current directory
			const isRepo = yield* git.isInsideGitRepo(process.cwd())
			if (!isRepo) {
				return yield* Effect.fail(
					new Error(
						"Not in a git repository. Please run this command inside a git repo.",
					),
				)
			}

			targetPath = yield* git.getGitRoot(process.cwd())
		}

		const createdFiles: string[] = []
		const injectedFiles: string[] = []

		// Check if initialized (has template in git config)
		const templateName = yield* getTemplateName(targetPath)

		if (!templateName) {
			return yield* Effect.fail(new RepositoryNotInitializedError())
		}

		verboseLog(`Using template: ${templateName}`)

		// Check if TASK.md already exists - if so, abort
		const taskMdPath = resolve(targetPath, "TASK.md")
		const taskMdExists = yield* fs.exists(taskMdPath)
		if (taskMdExists) {
			return yield* Effect.fail(
				new Error(
					"TASK.md already exists in the repository. This indicates something has gone wrong.\n" +
						"Please remove TASK.md manually before running 'agency task'.",
				),
			)
		}

		// Check if we're on a feature branch
		const currentBranch = yield* git.getCurrentBranch(targetPath)
		verboseLog(`Current branch: ${highlight.branch(currentBranch)}`)
		const isFeature = yield* git.isFeatureBranch(currentBranch, targetPath)
		verboseLog(`Is feature branch: ${isFeature}`)

		// If on main branch without a branch name, prompt for it (unless in silent mode)
		let branchName = options.branch
		if (!isFeature && !branchName) {
			if (silent) {
				return yield* Effect.fail(
					new Error(
						`You're currently on ${highlight.branch(currentBranch)}, which appears to be your main branch.\n` +
							`To initialize on a feature branch, either:\n` +
							`  1. Switch to an existing feature branch first, then run 'agency task'\n` +
							`  2. Provide a new branch name: 'agency task <branch-name>'`,
					),
				)
			}
			branchName = yield* promptService.prompt("Branch name: ")
			if (!branchName) {
				return yield* Effect.fail(
					new Error("Branch name is required when on main branch."),
				)
			}
			verboseLog(`Branch name from prompt: ${branchName}`)
		}

		// If we have a branch name and we're not on a feature branch, check if branch already exists
		if (!isFeature && branchName) {
			const exists = yield* git.branchExists(targetPath, branchName)
			if (exists) {
				return yield* Effect.fail(
					new Error(
						`Branch ${highlight.branch(branchName)} already exists.\n` +
							`Either switch to it first or choose a different branch name.`,
					),
				)
			}
			verboseLog(`Branch ${branchName} does not exist, will create it`)
		}

		// If we're going to create a branch, check if TASK.md will be created and prompt for description first
		let taskDescription: string | undefined
		if (!isFeature && branchName) {
			const taskMdExists = yield* fs.exists(taskMdPath)
			if (!taskMdExists) {
				if (options.task) {
					taskDescription = options.task
					verboseLog(`Using task from option: ${taskDescription}`)
				} else if (!silent) {
					taskDescription = yield* promptService.prompt("Task description: ")
					if (!taskDescription) {
						log(
							info(
								"Skipping task description (TASK.md will use default placeholder)",
							),
						)
						taskDescription = undefined
					}
				}
			}
		}

		if (!isFeature && branchName) {
			yield* createFeatureBranchEffect(targetPath, branchName, silent, verbose)
		}

		// Get managed files for later use
		const managedFiles = yield* Effect.promise(() => initializeManagedFiles())

		// Get template directory (it may or may not exist yet)
		const templateDir = yield* templateService.getTemplateDir(templateName)

		// Prompt for task if TASK.md will be created (only if not already prompted earlier)
		if (taskDescription === undefined) {
			const taskMdExists = yield* fs.exists(taskMdPath)
			if (!taskMdExists) {
				if (options.task) {
					taskDescription = options.task
					verboseLog(`Using task from option: ${taskDescription}`)
				} else if (!silent) {
					taskDescription = yield* promptService.prompt("Task description: ")
					if (!taskDescription) {
						log(
							info(
								"Skipping task description (TASK.md will use default placeholder)",
							),
						)
						taskDescription = undefined
					}
				}
			}
		}

		// Build list of files to create, combining managed files with any additional template files
		const filesToCreate = new Map<string, string>() // fileName -> content source

		// Start with all managed files (these should always be created)
		for (const managedFile of managedFiles) {
			filesToCreate.set(managedFile.name, "default")
		}

		// Discover all files from the template directory
		const templateFiles = yield* discoverTemplateFiles(templateDir, verboseLog)
		for (const relativePath of templateFiles) {
			filesToCreate.set(relativePath, "template")
		}

		verboseLog(
			`Discovered ${templateFiles.length} files in template: ${templateFiles.join(", ")}`,
		)

		// Process each file to create
		for (const [fileName, source] of filesToCreate) {
			const targetFilePath = resolve(targetPath, fileName)

			// Check if file exists in repo - if so, skip injection
			const exists = yield* fs.exists(targetFilePath)
			if (exists) {
				log(info(`Skipped ${highlight.file(fileName)} (exists in repo)`))
				continue
			}

			let content: string

			// Try to read from template first, fall back to default content
			if (source === "template") {
				const templateFilePath = join(templateDir, fileName)
				content = yield* fs.readFile(templateFilePath)
			} else {
				// Use default content from managed files
				const managedFile = managedFiles.find((f) => f.name === fileName)
				content = managedFile?.defaultContent ?? ""
			}

			// Replace {task} placeholder in TASK.md if task description was provided
			if (fileName === "TASK.md" && taskDescription) {
				content = content.replace("{task}", taskDescription)
				verboseLog(`Replaced {task} placeholder with: ${taskDescription}`)
			}

			yield* fs.writeFile(targetFilePath, content)
			createdFiles.push(fileName)

			// Track injected files (excluding TASK.md and AGENCY.md which are always filtered)
			if (fileName !== "TASK.md" && fileName !== "AGENCY.md") {
				injectedFiles.push(fileName)
			}

			log(done(`Created ${highlight.file(fileName)}`))
		}

		// Auto-detect base branch for this feature branch
		let baseBranch: string | undefined

		// Check repository-level default in git config
		baseBranch =
			(yield* git.getDefaultBaseBranchConfig(targetPath)) || undefined

		// If no repo-level default, try to auto-detect
		if (!baseBranch) {
			// Try main branch config
			baseBranch =
				(yield* git.getMainBranchConfig(targetPath)) ||
				(yield* git.findMainBranch(targetPath)) ||
				undefined

			// Try common base branches
			if (!baseBranch) {
				const commonBases = ["origin/main", "origin/master", "main", "master"]
				for (const base of commonBases) {
					const exists = yield* git.branchExists(targetPath, base)
					if (exists) {
						baseBranch = base
						break
					}
				}
			}
		}

		if (baseBranch) {
			verboseLog(`Auto-detected base branch: ${highlight.branch(baseBranch)}`)
		}

		// Create agency.json metadata file
		const metadata = {
			version: 1 as const,
			injectedFiles,
			baseBranch, // Save the base branch if detected
			template: templateName,
			createdAt: new Date().toISOString(),
		}
		yield* Effect.promise(() =>
			writeAgencyMetadata(targetPath, metadata as any),
		)
		createdFiles.push("agency.json")
		log(done(`Created ${highlight.file("agency.json")}`))
		if (baseBranch) {
			log(info(`Base branch: ${highlight.branch(baseBranch)}`))
		}
		verboseLog(
			`Tracked ${injectedFiles.length} injected file${plural(injectedFiles.length)}`,
		)

		// Git add and commit the created files
		if (createdFiles.length > 0) {
			try {
				yield* git.gitAdd(createdFiles, targetPath)
				yield* git.gitCommit("chore: agency task", targetPath, {
					noVerify: true,
				})
				log(
					done(
						`Committed ${highlight.value(createdFiles.length)} file${plural(createdFiles.length)}`,
					),
				)
			} catch (err) {
				// If commit fails, it might be because there are no changes (e.g., files already staged)
				// We can ignore this error and let the user handle it manually
				verboseLog(`Failed to commit: ${err}`)
			}
		}
	})

// Helper: Create feature branch with interactive prompts
const createFeatureBranchEffect = (
	targetPath: string,
	branchName: string,
	silent: boolean,
	verbose: boolean,
) =>
	Effect.gen(function* () {
		const { log, verboseLog } = createLoggers({ silent, verbose })
		const git = yield* GitService
		const promptService = yield* PromptService

		// Get or prompt for base branch
		let baseBranch: string | undefined =
			(yield* git.getMainBranchConfig(targetPath)) ||
			(yield* git.findMainBranch(targetPath)) ||
			undefined

		// If no base branch is configured and not in silent mode, prompt for it
		if (!baseBranch && !silent) {
			const suggestions = yield* git.getSuggestedBaseBranches(targetPath)
			if (suggestions.length > 0) {
				baseBranch = yield* promptService.promptForSelection(
					"Select base branch",
					suggestions,
				)
				verboseLog(`Selected base branch: ${baseBranch}`)

				// Save the main branch config if it's not already set
				const mainBranchConfig = yield* git.getMainBranchConfig(targetPath)
				if (!mainBranchConfig) {
					yield* git.setMainBranchConfig(baseBranch, targetPath)
					log(done(`Set main branch to ${highlight.branch(baseBranch)}`))
				}
			} else {
				return yield* Effect.fail(
					new Error(
						"Could not find any base branches. Please ensure your repository has at least one branch.",
					),
				)
			}
		} else if (!baseBranch && silent) {
			return yield* Effect.fail(
				new Error(
					"No base branch configured. Run without --silent to configure, or set agency.mainBranch in git config.",
				),
			)
		}

		yield* git.createBranch(branchName, targetPath, baseBranch)
		log(
			done(
				`Created and switched to branch ${highlight.branch(branchName)}${baseBranch ? ` based on ${highlight.branch(baseBranch)}` : ""}`,
			),
		)
	})

// Helper: Discover template files
const discoverTemplateFiles = (templateDir: string, verboseLog: Function) =>
	Effect.gen(function* () {
		const fs = yield* FileSystemService

		try {
			const result = yield* fs.runCommand(["find", templateDir, "-type", "f"], {
				captureOutput: true,
			})

			if (result.stdout) {
				const foundFiles = result.stdout
					.trim()
					.split("\n")
					.filter((f: string) => f.length > 0)
				const templateFiles: string[] = []

				for (const file of foundFiles) {
					// Get relative path from template directory
					const relativePath = file.replace(templateDir + "/", "")
					if (relativePath && !relativePath.startsWith(".")) {
						templateFiles.push(relativePath)
					}
				}

				return templateFiles
			}
		} catch (err) {
			verboseLog(`Error discovering template files: ${err}`)
		}

		return []
	})

// Effect-based taskEdit implementation
const taskEditEffect = (options: TaskEditOptions = {}) =>
	Effect.gen(function* () {
		const { log, verboseLog } = createLoggers(options)

		const git = yield* GitService
		const fs = yield* FileSystemService

		const gitRoot = yield* ensureGitRepo()

		const taskFilePath = resolve(gitRoot, "TASK.md")
		verboseLog(`TASK.md path: ${taskFilePath}`)

		// Check if TASK.md exists
		const exists = yield* fs.exists(taskFilePath)
		if (!exists) {
			return yield* Effect.fail(
				new Error(
					"TASK.md not found in repository root. Run 'agency task' first to create it.",
				),
			)
		}

		// Get editor from environment or use sensible defaults
		const editor =
			process.env.VISUAL ||
			process.env.EDITOR ||
			(process.platform === "darwin" ? "open" : "vim")

		verboseLog(`Using editor: ${editor}`)

		const result = yield* fs.runCommand([editor, taskFilePath])

		if (result.exitCode !== 0) {
			return yield* Effect.fail(
				new Error(`Editor exited with code ${result.exitCode}`),
			)
		}

		log(done("TASK.md edited"))
	})

const helpText = `
Usage: agency task [branch-name] [options]

Initialize template files (AGENTS.md, TASK.md, opencode.json) in a git repository.

IMPORTANT: 
  - You must run 'agency init' first to select a template
  - This command must be run on a feature branch, not the main branch

If you're on the main branch, you must either:
  1. Switch to an existing feature branch first, then run 'agency task'
  2. Provide a branch name: 'agency task <branch-name>'

When creating a new branch, you'll be prompted to select a base branch (e.g.,
main, develop) to branch from. This selection is saved to .git/config for
future use.

Initializes files at the root of the current git repository.

Arguments:
  branch-name       Create and switch to this branch before initializing

Options:
  -b, --branch      Branch name to create (alternative to positional arg)

Examples:
  agency init                        # First, initialize with template
  agency task                        # Then initialize on current feature branch
  agency task my-feature             # Create 'my-feature' branch and initialize

Template Workflow:
  1. Run 'agency init' to select template (saved to .git/config)
  2. Run 'agency task' to create template files on feature branch
  3. Use 'agency template save <file>' to update template with local changes
  4. Template directory only created when you save files to it

Branch Creation:
  1. When creating a new branch, you're prompted to select a base branch
  2. Suggested options include: main, master, develop, staging (if they exist)
  3. You can select from suggestions or enter a custom branch name
  4. Selection is saved to .git/config (agency.mainBranch) for future use
  5. In --silent mode, a base branch must already be configured

Notes:
  - Files are created at the git repository root, not the current directory
  - If files already exist in the repository, they will not be overwritten
  - Template selection is stored in .git/config (not committed)
  - To edit TASK.md after creation, use 'agency edit'
`

export const { execute: task, help } = createCommand<TaskOptions>({
	name: "task",
	services: ["git", "filesystem", "prompt", "template"],
	effect: taskEffect,
	help: helpText,
})

export async function taskEdit(options: TaskEditOptions = {}): Promise<void> {
	const { GitService } = await import("../services/GitService")
	const { FileSystemService } = await import("../services/FileSystemService")

	// Manually run the Effect since taskEdit is a separate command
	const { runEffect } = await import("../utils/effect")
	await runEffect(taskEditEffect(options), [
		GitService.Default,
		FileSystemService.Default,
	])
}
