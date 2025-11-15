import { resolve, join, basename } from "path"
import {
	isInsideGitRepo,
	getGitRoot,
	isGitRoot,
	getGitConfig,
	setGitConfig,
	getCurrentBranch,
	isFeatureBranch,
	createBranch,
	getSuggestedBaseBranches,
	getMainBranchConfig,
	findMainBranch,
	setMainBranchConfig,
	gitAdd,
	gitCommit,
	getDefaultBaseBranchConfig,
	branchExists,
} from "../utils/git"
import { getConfigDir } from "../config"
import { initializeManagedFiles, writeAgencyMetadata } from "../types"
import {
	prompt,
	sanitizeTemplateName,
	promptForBaseBranch,
} from "../utils/prompt"
import {
	getTemplateDir,
	createTemplateDir,
	templateExists,
} from "../utils/template"
import highlight, { done, info, plural } from "../utils/colors"

export interface TaskOptions {
	path?: string
	silent?: boolean
	verbose?: boolean
	template?: string
	task?: string
	branch?: string
}

export interface TaskEditOptions {
	silent?: boolean
	verbose?: boolean
}

export async function task(options: TaskOptions = {}): Promise<void> {
	const { silent = false, verbose = false } = options
	const log = silent ? () => {} : console.log
	const verboseLog = verbose && !silent ? console.log : () => {}

	let targetPath: string

	if (options.path) {
		// If path is provided, validate it's a git repository root
		targetPath = resolve(options.path)

		if (!(await isGitRoot(targetPath))) {
			throw new Error(
				"The specified path is not the root of a git repository. Please provide a path to the top-level directory of a git checkout.",
			)
		}
	} else {
		// If no path provided, use git root of current directory
		if (!(await isInsideGitRepo(process.cwd()))) {
			throw new Error(
				"Not in a git repository. Please run this command inside a git repo.",
			)
		}

		const gitRoot = await getGitRoot(process.cwd())
		if (!gitRoot) {
			throw new Error("Failed to determine the root of the git repository.")
		}

		targetPath = gitRoot
	}

	const configDir = getConfigDir()
	const createdFiles: string[] = []
	const injectedFiles: string[] = []

	try {
		// Check if TASK.md already exists - if so, abort
		const taskMdPath = resolve(targetPath, "TASK.md")
		const taskMdFile = Bun.file(taskMdPath)
		if (await taskMdFile.exists()) {
			throw new Error(
				"TASK.md already exists in the repository. This indicates something has gone wrong.\n" +
					"Please remove TASK.md manually before running 'agency task'.",
			)
		}

		// Check if we're on a feature branch
		const currentBranch = await getCurrentBranch(targetPath)
		verboseLog(`Current branch: ${highlight.branch(currentBranch)}`)
		const isFeature = await isFeatureBranch(currentBranch, targetPath)
		verboseLog(`Is feature branch: ${isFeature}`)

		// If on main branch without a branch name, prompt for it (unless in silent mode)
		let branchName = options.branch
		if (!isFeature && !branchName) {
			if (silent) {
				throw new Error(
					`You're currently on ${highlight.branch(currentBranch)}, which appears to be your main branch.\n` +
						`To initialize on a feature branch, either:\n` +
						`  1. Switch to an existing feature branch first, then run 'agency task'\n` +
						`  2. Provide a new branch name: 'agency task <branch-name>'`,
				)
			}
			branchName = await prompt("Branch name: ")
			if (!branchName) {
				throw new Error("Branch name is required when on main branch.")
			}
			verboseLog(`Branch name from prompt: ${branchName}`)
		}

		// If we have a branch name and we're not on a feature branch, check if branch already exists
		if (!isFeature && branchName) {
			const exists = await branchExists(targetPath, branchName)
			if (exists) {
				throw new Error(
					`Branch ${highlight.branch(branchName)} already exists.\n` +
						`Either switch to it first or choose a different branch name.`,
				)
			}
			verboseLog(`Branch ${branchName} does not exist, will create it`)
		}

		// If we're going to create a branch, check if TASK.md will be created and prompt for description first
		let taskDescription: string | undefined
		if (!isFeature && branchName) {
			const taskMdPath = resolve(targetPath, "TASK.md")
			const taskMdFile = Bun.file(taskMdPath)
			if (!(await taskMdFile.exists())) {
				if (options.task) {
					taskDescription = options.task
					verboseLog(`Using task from option: ${taskDescription}`)
				} else if (!silent) {
					taskDescription = await prompt("Task description: ")
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

		if (!isFeature) {
			// If a branch name was provided, create it
			if (branchName) {
				// Get or prompt for base branch
				let baseBranch: string | undefined =
					(await getMainBranchConfig(targetPath)) ||
					(await findMainBranch(targetPath)) ||
					undefined

				// If no base branch is configured and not in silent mode, prompt for it
				if (!baseBranch && !silent) {
					const suggestions = await getSuggestedBaseBranches(targetPath)
					if (suggestions.length > 0) {
						baseBranch = await promptForBaseBranch(suggestions)
						verboseLog(`Selected base branch: ${baseBranch}`)

						// Save the main branch config if it's not already set
						const mainBranchConfig = await getMainBranchConfig(targetPath)
						if (!mainBranchConfig) {
							await setMainBranchConfig(baseBranch, targetPath)
							log(done(`Set main branch to ${highlight.branch(baseBranch)}`))
						}
					} else {
						throw new Error(
							"Could not find any base branches. Please ensure your repository has at least one branch.",
						)
					}
				} else if (!baseBranch && silent) {
					throw new Error(
						"No base branch configured. Run without --silent to configure, or set agency.mainBranch in git config.",
					)
				}

				await createBranch(branchName, targetPath, baseBranch)
				log(
					done(
						`Created and switched to branch ${highlight.branch(branchName)}${baseBranch ? ` based on ${highlight.branch(baseBranch)}` : ""}`,
					),
				)
			}
		}

		// Get or prompt for template name
		let templateName =
			options.template || (await getGitConfig("agency.template", targetPath))
		let needsSaveToConfig = false

		if (!templateName) {
			// Prompt for template name if not in silent mode
			if (silent) {
				throw new Error(
					"No template configured. Run without --silent to configure, or use --template flag.",
				)
			}

			log("No template configured for this repository.")

			// Suggest directory name as default if no template exists with that name
			let defaultTemplateName: string | undefined
			const dirName = basename(targetPath)
			const sanitizedDirName = sanitizeTemplateName(dirName)

			if (sanitizedDirName && !(await templateExists(sanitizedDirName))) {
				defaultTemplateName = sanitizedDirName
				verboseLog(`Suggesting default template name: ${defaultTemplateName}`)
			}

			const answer = await prompt("Template name: ", defaultTemplateName)

			if (!answer) {
				throw new Error("Template name is required.")
			}

			templateName = sanitizeTemplateName(answer)
			verboseLog(`Sanitized template name: ${templateName}`)
			needsSaveToConfig = true
		} else if (options.template) {
			// Template was provided via option, not from git config
			const existingTemplate = await getGitConfig("agency.template", targetPath)
			if (existingTemplate !== options.template) {
				needsSaveToConfig = true
			}
			verboseLog(`Using template: ${templateName}`)
		} else {
			verboseLog(`Using template: ${templateName}`)
		}

		// Create template directory if it doesn't exist
		const templateDir = getTemplateDir(templateName)
		await createTemplateDir(templateName)

		// Check if template is new (doesn't have any files yet)
		// Initialize default template files if the template is brand new
		const managedFiles = await initializeManagedFiles()
		const templateAgents = Bun.file(join(templateDir, "AGENTS.md"))
		if (!(await templateAgents.exists())) {
			log(done(`Created template ${highlight.template(templateName)}`))

			// Copy default content to template for each managed file
			for (const managedFile of managedFiles) {
				const templateFilePath = join(templateDir, managedFile.name)
				const templateFile = Bun.file(templateFilePath)

				if (!(await templateFile.exists())) {
					const defaultContent = managedFile.defaultContent ?? ""
					await Bun.write(templateFilePath, defaultContent)
					verboseLog(`Created ${templateFilePath} with default content`)
				}
			}
		}

		// Save template name to git config if needed
		if (needsSaveToConfig) {
			await setGitConfig("agency.template", templateName, targetPath)
			log(
				done(
					`Set ${highlight.setting("agency.template")} = ${highlight.template(templateName)}`,
				),
			)
		}

		// Prompt for task if TASK.md will be created (only if not already prompted earlier)
		if (taskDescription === undefined) {
			const taskMdPath = resolve(targetPath, "TASK.md")
			const taskMdFile = Bun.file(taskMdPath)
			if (!(await taskMdFile.exists())) {
				if (options.task) {
					taskDescription = options.task
					verboseLog(`Using task from option: ${taskDescription}`)
				} else if (!silent) {
					taskDescription = await prompt("Task description: ")
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
		const templateFiles: string[] = []
		try {
			const result = Bun.spawnSync(["find", templateDir, "-type", "f"], {
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
					// Get relative path from template directory
					const relativePath = file.replace(templateDir + "/", "")
					if (relativePath && !relativePath.startsWith(".")) {
						templateFiles.push(relativePath)
						// Mark that this file should use template content
						filesToCreate.set(relativePath, "template")
					}
				}
			}
		} catch (err) {
			verboseLog(`Error discovering template files: ${err}`)
		}

		verboseLog(
			`Discovered ${templateFiles.length} files in template: ${templateFiles.join(", ")}`,
		)

		// Process each file to create
		for (const [fileName, source] of filesToCreate) {
			const targetFilePath = resolve(targetPath, fileName)
			const targetFile = Bun.file(targetFilePath)

			// Check if file exists in repo - if so, skip injection
			if (await targetFile.exists()) {
				log(info(`Skipped ${highlight.file(fileName)} (exists in repo)`))
				continue
			}

			let content: string

			// Try to read from template first, fall back to default content
			if (source === "template") {
				const templateFilePath = join(templateDir, fileName)
				const templateFile = Bun.file(templateFilePath)
				content = await templateFile.text()
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

			await Bun.write(targetFilePath, content)
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
		baseBranch = (await getDefaultBaseBranchConfig(targetPath)) || undefined

		// If no repo-level default, try to auto-detect
		if (!baseBranch) {
			// Try main branch config
			baseBranch =
				(await getMainBranchConfig(targetPath)) ||
				(await findMainBranch(targetPath)) ||
				undefined

			// Try common base branches
			if (!baseBranch) {
				const commonBases = ["origin/main", "origin/master", "main", "master"]
				for (const base of commonBases) {
					if (await branchExists(targetPath, base)) {
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
			version: 1,
			injectedFiles,
			baseBranch, // Save the base branch if detected
			template: templateName,
			createdAt: new Date().toISOString(),
		}
		await writeAgencyMetadata(targetPath, metadata)
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
				await gitAdd(createdFiles, targetPath)
				await gitCommit("chore: agency task", targetPath)
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
	} catch (err) {
		// Re-throw errors for CLI handler to display
		throw err
	}
}

export async function taskEdit(options: TaskEditOptions = {}): Promise<void> {
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

	const taskFilePath = resolve(gitRoot, "TASK.md")
	verboseLog(`TASK.md path: ${taskFilePath}`)

	// Check if TASK.md exists
	const taskFile = Bun.file(taskFilePath)
	if (!(await taskFile.exists())) {
		throw new Error(
			"TASK.md not found in repository root. Run 'agency task' first to create it.",
		)
	}

	// Get editor from environment or use sensible defaults
	const editor =
		process.env.VISUAL ||
		process.env.EDITOR ||
		(process.platform === "darwin" ? "open" : "vim")

	verboseLog(`Using editor: ${editor}`)

	try {
		// Spawn the editor process
		const proc = Bun.spawn([editor, taskFilePath], {
			stdio: ["inherit", "inherit", "inherit"],
		})

		// Wait for the editor to close
		const exitCode = await proc.exited

		if (exitCode !== 0) {
			throw new Error(`Editor exited with code ${exitCode}`)
		}

		log(done("TASK.md edited"))
	} catch (err) {
		if (err instanceof Error) {
			throw new Error(`Failed to open editor: ${err.message}`)
		}
		throw err
	}
}

export const help = `
Usage: agency task [branch-name] [options]

Initialize AGENTS.md and TASK.md files in a git repository using templates.

IMPORTANT: This command must be run on a feature branch, not the main branch.
If you're on the main branch, you must either:
  1. Switch to an existing feature branch first, then run 'agency task'
  2. Provide a branch name: 'agency task <branch-name>'

When creating a new branch, you'll be prompted to select a base branch (e.g.,
main, develop) to branch from. This selection is saved to .git/config for
future use.

Initializes files at the root of the current git repository.

On first run in a repository, you'll be prompted for a template name. This
creates a template directory at ~/.config/agency/templates/{name}/ and saves
the template name to .git/config for future use.

Arguments:
  branch-name       Create and switch to this branch before initializing

Options:
  -t, --template    Specify template name (skips prompt)
  -b, --branch      Branch name to create (alternative to positional arg)

Examples:
  agency task                        # Initialize on current feature branch
  agency task my-feature             # Create 'my-feature' branch and initialize
  agency task --template=work        # Initialize with specific template

Template Workflow:
  1. First run: Prompted for template name (e.g., "work")
  2. Template directory created at ~/.config/agency/templates/work/
  3. Template name saved to .git/config (agency.template = work)
  4. Subsequent runs: Automatically uses saved template
  5. Use 'agency template save' to update template with local changes

Branch Creation:
  1. When creating a new branch, you're prompted to select a base branch
  2. Suggested options include: main, master, develop, staging (if they exist)
  3. You can select from suggestions or enter a custom branch name
  4. Selection is saved to .git/config (agency.mainBranch) for future use
  5. In --silent mode, a base branch must already be configured

Notes:
  - Files are created at the git repository root, not the current directory
  - If files already exist, they will not be overwritten
  - Templates are stored per-repository in .git/config (not committed)
  - Use --template flag to override saved template or skip prompt
  - To edit TASK.md after creation, use 'agency edit'
`
