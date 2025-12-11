import { resolve, join } from "path"
import { Effect } from "effect"
import type { BaseCommandOptions } from "../utils/command"
import { IsomorphicGitService as GitService } from "../services/IsomorphicGitService"
import { ConfigService } from "../services/ConfigService"
import { FileSystemService } from "../services/FileSystemService"
import { PromptService } from "../services/PromptService"
import { TemplateService } from "../services/TemplateService"
import { OpencodeService } from "../services/OpencodeService"
import { initializeManagedFiles, writeAgencyMetadata } from "../types"
import { RepositoryNotInitializedError } from "../errors"
import highlight, { done, info, plural } from "../utils/colors"
import { createLoggers, ensureGitRepo, getTemplateName } from "../utils/effect"
import {
	makeEmitBranchName,
	extractCleanBranch,
	makeSourceBranchName,
} from "../utils/pr-branch"

interface TaskOptions extends BaseCommandOptions {
	path?: string
	task?: string
	branch?: string
	from?: string
	fromCurrent?: boolean
}

interface TaskEditOptions extends BaseCommandOptions {}

export const task = (options: TaskOptions = {}) =>
	Effect.gen(function* () {
		const { silent = false, verbose = false } = options
		const { log, verboseLog } = createLoggers(options)

		const git = yield* GitService
		const configService = yield* ConfigService
		const fs = yield* FileSystemService
		const promptService = yield* PromptService
		const templateService = yield* TemplateService
		const opencodeService = yield* OpencodeService

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

		// Define path to TASK.md for later checks
		const taskMdPath = resolve(targetPath, "TASK.md")

		// Check if we're on a feature branch
		const currentBranch = yield* git.getCurrentBranch(targetPath)
		verboseLog(`Current branch: ${highlight.branch(currentBranch)}`)
		const isFeature = yield* git.isFeatureBranch(currentBranch, targetPath)
		verboseLog(`Is feature branch: ${isFeature}`)

		// Determine base branch to branch from
		let baseBranchToBranchFrom: string | undefined

		// Handle --from and --from-current flags
		if (options.from && options.fromCurrent) {
			return yield* Effect.fail(
				new Error("Cannot use both --from and --from-current flags together."),
			)
		}

		if (options.fromCurrent) {
			// Branch from current branch
			baseBranchToBranchFrom = currentBranch
			verboseLog(
				`Using current branch as base: ${highlight.branch(currentBranch)}`,
			)
		} else if (options.from) {
			// Branch from specified branch
			baseBranchToBranchFrom = options.from
			verboseLog(
				`Using specified branch as base: ${highlight.branch(options.from)}`,
			)

			// Verify the specified branch exists
			const exists = yield* git.branchExists(targetPath, baseBranchToBranchFrom)
			if (!exists) {
				return yield* Effect.fail(
					new Error(
						`Branch ${highlight.branch(baseBranchToBranchFrom)} does not exist.`,
					),
				)
			}
		} else {
			// Default: determine main upstream branch
			baseBranchToBranchFrom =
				(yield* git.getMainBranchConfig(targetPath)) ||
				(yield* git.findMainBranch(targetPath)) ||
				undefined

			// If still no base branch, try to auto-detect from remote
			if (!baseBranchToBranchFrom) {
				const remote = yield* git
					.resolveRemote(targetPath)
					.pipe(Effect.catchAll(() => Effect.succeed(null)))

				const commonBases: string[] = []
				if (remote) {
					commonBases.push(`${remote}/main`, `${remote}/master`)
				}
				commonBases.push("main", "master")

				for (const base of commonBases) {
					const exists = yield* git.branchExists(targetPath, base)
					if (exists) {
						baseBranchToBranchFrom = base
						break
					}
				}
			}

			if (baseBranchToBranchFrom) {
				verboseLog(
					`Auto-detected base branch: ${highlight.branch(baseBranchToBranchFrom)}`,
				)
			}
		}

		// Check if the base branch is an agency source branch
		// If so, we need to emit it first and use the emit branch instead
		if (baseBranchToBranchFrom) {
			const config = yield* configService.loadConfig()
			const cleanFromBase = extractCleanBranch(
				baseBranchToBranchFrom,
				config.sourceBranchPattern,
			)

			if (cleanFromBase) {
				// This is an agency source branch - we need to use its emit branch
				verboseLog(
					`Base branch ${highlight.branch(baseBranchToBranchFrom)} is an agency source branch`,
				)

				const emitBranchName = makeEmitBranchName(
					cleanFromBase,
					config.emitBranch,
				)

				// Check if emit branch exists
				const emitExists = yield* git.branchExists(targetPath, emitBranchName)

				if (!emitExists) {
					return yield* Effect.fail(
						new Error(
							`Base branch ${highlight.branch(baseBranchToBranchFrom)} is an agency source branch, ` +
								`but its emit branch ${highlight.branch(emitBranchName)} does not exist.\n` +
								`Please run 'agency emit' on ${highlight.branch(baseBranchToBranchFrom)} first, ` +
								`or choose a different base branch.`,
						),
					)
				}

				// Use the emit branch as the base
				baseBranchToBranchFrom = emitBranchName
				verboseLog(
					`Using emit branch as base: ${highlight.branch(baseBranchToBranchFrom)}`,
				)
			}
		}

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

		// If we have a branch name, apply source pattern and check if branch exists
		let sourceBranchName: string | undefined
		if (branchName) {
			const config = yield* configService.loadConfig()
			sourceBranchName = makeSourceBranchName(
				branchName,
				config.sourceBranchPattern,
			)

			const exists = yield* git.branchExists(targetPath, sourceBranchName)
			if (exists) {
				return yield* Effect.fail(
					new Error(
						`Branch ${highlight.branch(sourceBranchName)} already exists.\n` +
							`Either switch to it first or choose a different branch name.`,
					),
				)
			}
			verboseLog(
				`Branch ${sourceBranchName} does not exist (from clean name: ${branchName}), will create it`,
			)
		}

		// If we're going to create a branch, check if TASK.md will be created and prompt for description first
		let taskDescription: string | undefined
		if (branchName) {
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

		if (sourceBranchName) {
			yield* createFeatureBranchEffect(
				targetPath,
				sourceBranchName,
				baseBranchToBranchFrom,
				silent,
				verbose,
			)
		}

		// Get managed files for later use
		const managedFiles = yield* Effect.tryPromise({
			try: () => initializeManagedFiles(),
			catch: (error) =>
				new Error(`Failed to initialize managed files: ${error}`),
		})

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

		// Check if opencode.json or opencode.jsonc already exists before processing files
		const existingOpencodeInfo = yield* opencodeService
			.detectOpencodeFile(targetPath)
			.pipe(Effect.catchAll(() => Effect.succeed(null)))

		// Process each file to create
		for (const [fileName, source] of filesToCreate) {
			const targetFilePath = resolve(targetPath, fileName)

			// Special handling for opencode.json if opencode.json/jsonc already exists
			if (fileName === "opencode.json" && existingOpencodeInfo) {
				// Merge with existing file instead of creating new one
				verboseLog(
					`Found existing ${existingOpencodeInfo.relativePath}, will merge instructions`,
				)

				// Get the instructions we want to add from our default content
				const managedFile = managedFiles.find((f) => f.name === "opencode.json")
				const defaultContent = managedFile?.defaultContent ?? "{}"
				const defaultConfig = JSON.parse(defaultContent) as {
					instructions?: string[]
				}
				const instructionsToAdd = defaultConfig.instructions || []

				// Merge the instructions
				const mergedFilePath = yield* opencodeService
					.mergeOpencodeFile(targetPath, instructionsToAdd)
					.pipe(
						Effect.catchAll((error) => {
							verboseLog(
								`Failed to merge ${existingOpencodeInfo.relativePath}: ${error.message}`,
							)
							return Effect.succeed(existingOpencodeInfo.relativePath)
						}),
					)

				// Track the file that was modified (use the actual relative path)
				createdFiles.push(mergedFilePath)
				injectedFiles.push(mergedFilePath)

				log(done(`Merged ${highlight.file(mergedFilePath)}`))
				continue
			}

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

			// Track backpack files (excluding TASK.md and AGENCY.md which are always filtered)
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

			// Try common base branches with dynamic remote
			if (!baseBranch) {
				const remote = yield* git
					.resolveRemote(targetPath)
					.pipe(Effect.catchAll(() => Effect.succeed(null)))

				const commonBases: string[] = []
				if (remote) {
					commonBases.push(`${remote}/main`, `${remote}/master`)
				}
				commonBases.push("main", "master")

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

		// Calculate emitBranch name from current branch
		const finalBranch = yield* git.getCurrentBranch(targetPath)
		const config = yield* configService.loadConfig()
		// Extract clean branch name from source pattern, or use branch as-is for legacy branches
		const cleanBranch =
			extractCleanBranch(finalBranch, config.sourceBranchPattern) || finalBranch
		const emitBranchName = makeEmitBranchName(cleanBranch, config.emitBranch)

		// Create agency.json metadata file
		const metadata = {
			version: 1 as const,
			injectedFiles,
			baseBranch, // Save the base branch if detected
			emitBranch: emitBranchName, // Save the emit branch name
			template: templateName,
			createdAt: new Date().toISOString(),
		}
		yield* Effect.tryPromise({
			try: () => writeAgencyMetadata(targetPath, metadata as any),
			catch: (error) => new Error(`Failed to write agency metadata: ${error}`),
		})
		createdFiles.push("agency.json")
		log(done(`Created ${highlight.file("agency.json")}`))
		if (baseBranch) {
			verboseLog(`Base branch: ${highlight.branch(baseBranch)}`)
		}
		verboseLog(`Tracked backpack file${plural(injectedFiles.length)}`)

		// Git add and commit the created files
		if (createdFiles.length > 0) {
			yield* Effect.gen(function* () {
				yield* git.gitAdd(createdFiles, targetPath)
				yield* git.gitCommit("chore: agency task", targetPath, {
					noVerify: true,
				})
				verboseLog(
					`Committed ${createdFiles.length} file${plural(createdFiles.length)}`,
				)
			}).pipe(
				Effect.catchAll((err) => {
					// If commit fails, it might be because there are no changes (e.g., files already staged)
					// We can ignore this error and let the user handle it manually
					verboseLog(`Failed to commit: ${err}`)
					return Effect.void
				}),
			)
		}
	})

// Helper: Create feature branch with interactive prompts
const createFeatureBranchEffect = (
	targetPath: string,
	branchName: string,
	providedBaseBranch: string | undefined,
	silent: boolean,
	verbose: boolean,
) =>
	Effect.gen(function* () {
		const { log, verboseLog } = createLoggers({ silent, verbose })
		const git = yield* GitService
		const promptService = yield* PromptService

		// Use provided base branch if available, otherwise get or prompt for one
		let baseBranch: string | undefined = providedBaseBranch

		if (!baseBranch) {
			baseBranch =
				(yield* git.getMainBranchConfig(targetPath)) ||
				(yield* git.findMainBranch(targetPath)) ||
				undefined
		}

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

export const help = `
Usage: agency task [branch-name] [options]

Initialize template files (AGENTS.md, TASK.md, opencode.json) in a git repository.

IMPORTANT: 
  - You must run 'agency init' first to select a template
  - This command must be run on a feature branch, not the main branch

If you're on the main branch, you must either:
  1. Switch to an existing feature branch first, then run 'agency task'
  2. Provide a branch name: 'agency task <branch-name>'

Initializes files at the root of the current git repository.

Arguments:
  branch-name       Create and switch to this branch before initializing

Options:
  -b, --branch      Branch name to create (alternative to positional arg)
  --from <branch>   Branch to branch from instead of main upstream branch
  --from-current    Branch from the current branch

Base Branch Selection:
  By default, 'agency task' branches from the main upstream branch (e.g., origin/main).
  You can override this behavior with:
  
  - --from <branch>: Branch from a specific branch
  - --from-current: Branch from your current branch
  
  If the base branch is an agency source branch (e.g., agency/branch-A), the command
  will automatically use its emit branch instead. This allows you to layer work on top
  of other feature branches while maintaining clean branch history.

Examples:
  agency task                          # Branch from main upstream branch
  agency task --from agency/branch-B   # Branch from agency/branch-B's emit branch
  agency task --from-current           # Branch from current branch's emit branch
  agency task my-feature --from develop # Create 'my-feature' from 'develop'

Template Workflow:
  1. Run 'agency init' to select template (saved to .git/config)
  2. Run 'agency task' to create template files on feature branch
  3. Use 'agency template save <file>' to update template with local changes
  4. Template directory only created when you save files to it

Branch Creation:
  When creating a new branch without --from or --from-current:
  1. Auto-detects main upstream branch (origin/main, origin/master, etc.)
  2. Falls back to configured main branch in .git/config (agency.mainBranch)
  3. In --silent mode, a base branch must already be configured
  
  When using --from with an agency source branch:
  1. Verifies the emit branch exists for the source branch
  2. Uses the emit branch as the actual base to avoid agency files
  3. Fails if emit branch doesn't exist (run 'agency emit' first)

Notes:
  - Files are created at the git repository root, not the current directory
  - If files already exist in the repository, they will not be overwritten
  - Template selection is stored in .git/config (not committed)
  - To edit TASK.md after creation, use 'agency edit'
`

export const taskEdit = (options: TaskEditOptions = {}) =>
	taskEditEffect(options)
