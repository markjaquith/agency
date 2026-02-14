import { resolve, join, dirname } from "path"
import { Effect } from "effect"
import type { BaseCommandOptions } from "../utils/command"
import { GitService } from "../services/GitService"
import { ConfigService } from "../services/ConfigService"
import { FileSystemService } from "../services/FileSystemService"
import { PromptService } from "../services/PromptService"
import { TemplateService } from "../services/TemplateService"
import { OpencodeService } from "../services/OpencodeService"
import { ClaudeService } from "../services/ClaudeService"
import { AgencyMetadataService } from "../services/AgencyMetadataService"
import { FormatterService } from "../services/FormatterService"
import { spawnProcess } from "../utils/process"
import { initializeManagedFiles, writeAgencyMetadata } from "../types"
import { RepositoryNotInitializedError } from "../errors"
import highlight, { done, info, plural } from "../utils/colors"
import { createLoggers, ensureGitRepo, getTemplateName } from "../utils/effect"
import {
	makeEmitBranchName,
	extractCleanBranch,
	makeSourceBranchName,
} from "../utils/pr-branch"
import { getTopLevelDir, dirToGlobPattern } from "../utils/glob"
import {
	AGENCY_REMOVE_COMMIT,
	AGENCY_WORKTREES_DIR,
	WORKTREE_INIT_SCRIPT,
} from "../constants"
import { emitCore } from "./emit"
import { withBranchProtection } from "../utils/effect"

interface TaskOptions extends BaseCommandOptions {
	path?: string
	task?: string
	emit?: string
	branch?: string // Deprecated: use emit instead
	from?: string
	fromCurrent?: boolean
	continue?: boolean
	squash?: boolean
	worktree?: boolean
}

interface TaskEditOptions extends BaseCommandOptions {}

/**
 * Continue a task by creating a new branch with the same agency files.
 * This is useful after a PR is merged and you want to continue working on the task.
 *
 * With --squash: emits the old branch, squash-merges the emitted commits into the new
 * branch as a single commit, and creates a fresh TASK.md with a new task description.
 */
const taskContinue = (options: TaskOptions) =>
	Effect.gen(function* () {
		const { silent = false, squash = false } = options
		const { log, verboseLog } = createLoggers(options)

		const git = yield* GitService
		const configService = yield* ConfigService
		const fs = yield* FileSystemService
		const promptService = yield* PromptService

		// Determine target path
		let targetPath: string

		if (options.path) {
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

		// Check if initialized (has template in git config)
		const templateName = yield* getTemplateName(targetPath)
		if (!templateName) {
			return yield* Effect.fail(new RepositoryNotInitializedError())
		}

		const currentBranch = yield* git.getCurrentBranch(targetPath)
		verboseLog(`Current branch: ${highlight.branch(currentBranch)}`)

		// Load agency config for branch patterns
		const config = yield* configService.loadConfig()

		// Verify we're on an agency source branch by checking if agency.json exists
		const agencyJsonPath = resolve(targetPath, "agency.json")
		const hasAgencyJson = yield* fs.exists(agencyJsonPath)

		if (!hasAgencyJson) {
			return yield* Effect.fail(
				new Error(
					`No agency.json found on current branch ${highlight.branch(currentBranch)}.\n` +
						`The --continue flag requires you to be on an agency source branch with existing agency files.`,
				),
			)
		}

		// Read the existing agency.json to get metadata
		const existingMetadata = yield* Effect.gen(function* () {
			const service = yield* AgencyMetadataService
			return yield* service.readFromDisk(targetPath)
		}).pipe(Effect.provide(AgencyMetadataService.Default))

		if (!existingMetadata) {
			return yield* Effect.fail(
				new Error(
					`Failed to read agency.json on branch ${highlight.branch(currentBranch)}.`,
				),
			)
		}

		verboseLog(
			`Existing metadata: ${JSON.stringify(existingMetadata, null, 2)}`,
		)

		// Get the list of agency files to copy
		const filesToCopy = [
			"agency.json",
			"TASK.md",
			"AGENCY.md",
			...existingMetadata.injectedFiles,
		]
		verboseLog(`Files to copy: ${filesToCopy.join(", ")}`)

		// Read all the existing files content before switching branches
		const fileContents = new Map<string, string>()
		for (const file of filesToCopy) {
			// When squashing, skip reading TASK.md — we'll generate a fresh one
			if (squash && file === "TASK.md") {
				verboseLog("Skipping TASK.md read (will create fresh for --squash)")
				continue
			}
			const filePath = resolve(targetPath, file)
			const exists = yield* fs.exists(filePath)
			if (exists) {
				const content = yield* fs.readFile(filePath)
				fileContents.set(file, content)
				verboseLog(`Read ${file} (${content.length} bytes)`)
			} else {
				verboseLog(`File ${file} not found, skipping`)
			}
		}

		// When squashing, prompt for fresh task description before switching branches
		let freshTaskDescription: string | undefined
		if (squash) {
			if (options.task) {
				freshTaskDescription = options.task
				verboseLog(`Using task from option: ${freshTaskDescription}`)
			} else if (!silent) {
				freshTaskDescription = yield* promptService.prompt(
					"New task description: ",
				)
				if (!freshTaskDescription) {
					log(
						info(
							"Skipping task description (TASK.md will use default placeholder)",
						),
					)
				}
			}
		}

		// Prompt for new branch name if not provided
		let branchName = options.emit || options.branch
		if (!branchName) {
			if (silent) {
				return yield* Effect.fail(
					new Error(
						"Branch name is required with --continue in silent mode. Use --emit to specify one.",
					),
				)
			}
			branchName = yield* promptService.prompt("New branch name: ")
			if (!branchName) {
				return yield* Effect.fail(
					new Error("Branch name is required to continue the task."),
				)
			}
		}

		// Apply source pattern to get the full source branch name
		const sourceBranchName = makeSourceBranchName(
			branchName,
			config.sourceBranchPattern,
		)

		// Check if the new branch already exists
		const branchExists = yield* git.branchExists(targetPath, sourceBranchName)
		if (branchExists) {
			return yield* Effect.fail(
				new Error(
					`Branch ${highlight.branch(sourceBranchName)} already exists.\n` +
						`Choose a different branch name.`,
				),
			)
		}

		// When squashing, emit the old source branch first (before switching away)
		// This creates a clean emit branch with backpack files stripped out
		let oldEmitBranchName: string | undefined
		if (squash) {
			const cleanFromCurrent = extractCleanBranch(
				currentBranch,
				config.sourceBranchPattern,
			)
			oldEmitBranchName = cleanFromCurrent
				? makeEmitBranchName(cleanFromCurrent, config.emitBranch)
				: existingMetadata.emitBranch || undefined

			if (!oldEmitBranchName) {
				return yield* Effect.fail(
					new Error(
						`Could not determine emit branch name for ${highlight.branch(currentBranch)}.\n` +
							`Ensure agency.json has an emitBranch field or the branch follows the source pattern.`,
					),
				)
			}

			verboseLog(
				`Emitting ${highlight.branch(currentBranch)} → ${highlight.branch(oldEmitBranchName)}`,
			)

			yield* withBranchProtection(
				targetPath,
				emitCore(targetPath, {
					silent: true,
					verbose: options.verbose,
					emit: oldEmitBranchName,
				}),
			)

			log(done(`Emitted ${highlight.branch(oldEmitBranchName)} for squash`))
		}

		// Determine base branch to branch from
		let baseBranchToBranchFrom: string | undefined

		if (options.from) {
			baseBranchToBranchFrom = options.from
			const exists = yield* git.branchExists(targetPath, baseBranchToBranchFrom)
			if (!exists) {
				return yield* Effect.fail(
					new Error(
						`Branch ${highlight.branch(baseBranchToBranchFrom)} does not exist.`,
					),
				)
			}
		} else {
			// Default: branch from main upstream branch (preferring remote)
			baseBranchToBranchFrom =
				(yield* git.resolveMainBranch(targetPath)) || undefined
		}

		if (!baseBranchToBranchFrom) {
			return yield* Effect.fail(
				new Error(
					"Could not determine base branch. Use --from to specify one.",
				),
			)
		}

		verboseLog(
			`Creating new branch ${highlight.branch(sourceBranchName)} from ${highlight.branch(baseBranchToBranchFrom)}`,
		)

		// Create the new branch from the base branch
		yield* git.createBranch(
			sourceBranchName,
			targetPath,
			baseBranchToBranchFrom,
		)
		// Calculate the emit branch name for display
		const cleanBranchForDisplay =
			extractCleanBranch(sourceBranchName, config.sourceBranchPattern) ||
			sourceBranchName
		const emitBranchForDisplay = makeEmitBranchName(
			cleanBranchForDisplay,
			config.emitBranch,
		)

		log(
			info(
				`(${highlight.branch(baseBranchToBranchFrom)}) ${highlight.branch(sourceBranchName)} → ${highlight.branch(emitBranchForDisplay)}`,
			),
		)
		log(done(`Created and switched to ${highlight.branch(sourceBranchName)}`))

		// When squashing, merge the emitted commits as a single squash commit
		if (squash && oldEmitBranchName) {
			verboseLog(
				`Squash-merging ${highlight.branch(oldEmitBranchName)} into ${highlight.branch(sourceBranchName)}`,
			)

			// Squash merge the emitted (clean) branch
			const mergeResult = yield* git
				.merge(targetPath, oldEmitBranchName, { squash: true })
				.pipe(
					Effect.catchAll((err) => {
						return Effect.fail(
							new Error(
								`Squash merge of ${oldEmitBranchName} failed.\n` +
									`This typically means there are conflicts with the base branch.\n` +
									`Try rebasing the old branch first with 'agency rebase', then retry.\n` +
									`Details: ${err}`,
							),
						)
					}),
				)

			// Check if the squash merge produced any staged changes
			const statusResult = yield* git
				.runGitCommand(["git", "diff", "--cached", "--quiet"], targetPath)
				.pipe(
					Effect.catchAll(() =>
						Effect.succeed({ exitCode: 1, stdout: "", stderr: "" }),
					),
				)

			if (statusResult.exitCode === 0) {
				// No changes — the old branch had no code commits (only agency files)
				verboseLog(
					"Squash merge produced no changes (old branch had no code commits), skipping squash commit",
				)
			} else {
				// There are staged changes — commit them
				yield* git.gitCommit(
					`squash: prior work from ${oldEmitBranchName}`,
					targetPath,
					{ noVerify: true },
				)
				log(
					done(
						`Squashed prior work from ${highlight.branch(oldEmitBranchName)}`,
					),
				)
			}
		}

		// Calculate the new emit branch name
		const newEmitBranchName = makeEmitBranchName(branchName, config.emitBranch)
		verboseLog(`New emit branch name: ${newEmitBranchName}`)

		// When squashing, generate fresh TASK.md content
		if (squash) {
			const taskTemplate = `{task}\n\n## Tasks\n\n- [ ] Populate this list with tasks\n`
			const taskContent = freshTaskDescription
				? taskTemplate.replace("{task}", freshTaskDescription)
				: taskTemplate
			fileContents.set("TASK.md", taskContent)
		}

		// Write all the files to the new branch
		const createdFiles: string[] = []

		for (const [file, content] of fileContents) {
			const filePath = resolve(targetPath, file)

			// Ensure parent directory exists
			const parentDir = resolve(filePath, "..")
			const parentExists = yield* fs.exists(parentDir)
			if (!parentExists) {
				yield* fs.runCommand(["mkdir", "-p", parentDir])
			}

			let fileContent = content

			// Update emitBranch in agency.json
			if (file === "agency.json") {
				const metadata = JSON.parse(content)
				metadata.emitBranch = newEmitBranchName
				metadata.createdAt = new Date().toISOString()
				fileContent = JSON.stringify(metadata, null, 2) + "\n"
				verboseLog(
					`Updated agency.json with new emitBranch: ${newEmitBranchName}`,
				)
			}

			// Update emitBranch in opencode.json (if it has one)
			if (file === "opencode.json" || file.endsWith("/opencode.json")) {
				try {
					const opencodeConfig = JSON.parse(content)
					if (opencodeConfig.emitBranch) {
						opencodeConfig.emitBranch = newEmitBranchName
						fileContent = JSON.stringify(opencodeConfig, null, "\t") + "\n"
						verboseLog(
							`Updated ${file} with new emitBranch: ${newEmitBranchName}`,
						)
					}
				} catch {
					// If we can't parse it, just copy as-is
				}
			}

			yield* fs.writeFile(filePath, fileContent)
			createdFiles.push(file)
			log(done(`Created ${highlight.file(file)}`))
		}

		// Format created files using project's formatter (prettier/oxfmt)
		const formatterService = yield* FormatterService
		yield* formatterService.formatFiles(targetPath, createdFiles, verboseLog)

		// Git add and commit the created files
		if (createdFiles.length > 0) {
			yield* Effect.gen(function* () {
				yield* git.gitAdd(createdFiles, targetPath)
				// Format: chore: agency task --continue (baseBranch) originalSource => newSource => newEmit
				const continueFlag = squash
					? "agency task --continue --squash"
					: "agency task --continue"
				const commitMessage = `chore: ${continueFlag} (${baseBranchToBranchFrom}) ${currentBranch} → ${sourceBranchName} → ${newEmitBranchName}`
				yield* git.gitCommit(commitMessage, targetPath, {
					noVerify: true,
				})
				verboseLog(
					`Committed ${createdFiles.length} file${plural(createdFiles.length)}`,
				)
			}).pipe(
				Effect.catchAll((err) => {
					verboseLog(`Failed to commit: ${err}`)
					return Effect.void
				}),
			)
		}

		log(
			info(
				squash
					? `Continued task with squash and ${createdFiles.length} file${plural(createdFiles.length)} from ${highlight.branch(currentBranch)}`
					: `Continued task with ${createdFiles.length} file${plural(createdFiles.length)} from ${highlight.branch(currentBranch)}`,
			),
		)
	})

export const task = (options: TaskOptions = {}) =>
	Effect.gen(function* () {
		const { silent = false, verbose = false } = options
		const { log, verboseLog } = createLoggers(options)

		// Validate --squash requires --continue
		if (options.squash && !options.continue) {
			return yield* Effect.fail(
				new Error("The --squash flag can only be used with --continue."),
			)
		}

		// Validate --worktree incompatibilities
		if (options.worktree && options.fromCurrent) {
			return yield* Effect.fail(
				new Error(
					"Cannot use --worktree with --from-current. Worktrees always create a new branch.",
				),
			)
		}
		if (options.worktree && options.continue) {
			return yield* Effect.fail(
				new Error("Cannot use --worktree with --continue."),
			)
		}

		// Handle --continue flag
		if (options.continue) {
			return yield* taskContinue(options)
		}

		const git = yield* GitService
		const configService = yield* ConfigService
		const fs = yield* FileSystemService
		const promptService = yield* PromptService
		const templateService = yield* TemplateService
		const opencodeService = yield* OpencodeService
		const claudeService = yield* ClaudeService

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

		// For worktrees, resolve the main repo root (in case we're already in a worktree)
		const mainRepoRoot = options.worktree
			? yield* git.getMainRepoRoot(targetPath)
			: targetPath

		const createdFiles: string[] = []
		const injectedFiles: string[] = []
		// Track directories that we create during this task
		// These will be converted to glob patterns for filtering
		const createdDirs = new Set<string>()

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

		// Check if we're on an agency source branch (has agency.json with backpacked files)
		const agencyJsonPath = resolve(targetPath, "agency.json")
		const hasAgencyJson = yield* fs.exists(agencyJsonPath)
		verboseLog(`Has agency.json: ${hasAgencyJson}`)

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
			// Default: fetch and use latest main upstream branch
			// First, determine the remote to fetch from
			const remote =
				(yield* git.getRemoteConfig(targetPath)) ||
				(yield* git.findDefaultRemote(targetPath))

			if (remote) {
				// Get just the branch name (e.g., "main") to fetch only that branch
				// This is much faster than fetching all branches in large repos
				const mainBranchName = yield* git.getMainBranchName(targetPath)

				if (mainBranchName) {
					log(
						info(
							`Fetching latest from ${highlight.branch(`${remote}/${mainBranchName}`)}...`,
						),
					)
					verboseLog(`Fetching ${mainBranchName} from remote: ${remote}`)
					yield* git.fetch(targetPath, remote, mainBranchName).pipe(
						Effect.catchAll((err) => {
							verboseLog(
								`Failed to fetch ${mainBranchName} from ${remote}: ${err}`,
							)
							return Effect.void
						}),
					)
				} else {
					// Fallback: fetch all branches if we can't determine the main branch
					log(info(`Fetching latest from ${highlight.branch(remote)}...`))
					verboseLog(`Fetching all branches from remote: ${remote}`)
					yield* git.fetch(targetPath, remote).pipe(
						Effect.catchAll((err) => {
							verboseLog(`Failed to fetch from ${remote}: ${err}`)
							return Effect.void
						}),
					)
				}
			}

			// Now resolve the main branch (preferring remote)
			baseBranchToBranchFrom =
				(yield* git.resolveMainBranch(targetPath)) || undefined

			if (baseBranchToBranchFrom) {
				verboseLog(
					`Auto-detected base branch: ${highlight.branch(baseBranchToBranchFrom)}`,
				)
			}
		}

		// Load config early for branch pattern operations
		const config = yield* configService.loadConfig()

		// Check if the base branch is an agency source branch
		// If so, we need to emit it first and use the emit branch instead
		// Skip this check if using --from-current (we want to stay on current branch, not branch from it)
		if (baseBranchToBranchFrom && !options.fromCurrent) {
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

		// Determine branch name logic
		let branchName = options.emit || options.branch

		// Determine if we need a new branch name:
		// - With --from-current on a feature branch without agency.json: can stay on current branch
		// - All other cases: require a new branch name
		const canStayOnCurrentBranch =
			options.fromCurrent && isFeature && !hasAgencyJson

		if (!branchName && !canStayOnCurrentBranch) {
			if (silent) {
				if (hasAgencyJson) {
					return yield* Effect.fail(
						new Error(
							`You're currently on ${highlight.branch(currentBranch)}, which is an agency source branch.\n` +
								`Branch name is required when re-importing backpacked files.\n` +
								`Use: 'agency task <branch-name>' or 'agency task --continue <branch-name>'`,
						),
					)
				}
				return yield* Effect.fail(
					new Error(
						`Branch name is required.\n` +
							`Use: 'agency task <branch-name>'\n` +
							`Or use --from-current to initialize on the current branch.`,
					),
				)
			}
			branchName = yield* promptService.prompt("Branch name: ")
			if (!branchName) {
				return yield* Effect.fail(new Error("Branch name is required."))
			}
			verboseLog(`Branch name from prompt: ${branchName}`)
		}

		// If we have a branch name, apply source pattern and check if branch exists
		let sourceBranchName: string | undefined
		if (branchName) {
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

		if (sourceBranchName && options.worktree) {
			// Create a worktree instead of just a branch
			const branchCleanName = branchName!
			const worktreePath = resolve(
				mainRepoRoot,
				AGENCY_WORKTREES_DIR,
				branchCleanName,
			)

			// Ensure .agency-worktrees/ is in .git/info/exclude
			yield* ensureWorktreeExclude(mainRepoRoot)

			verboseLog(`Creating worktree at ${worktreePath}`)

			// Create the worktree with a new branch
			yield* git.addWorktree(mainRepoRoot, worktreePath, sourceBranchName, {
				createBranch: true,
				baseBranch: baseBranchToBranchFrom,
				noTrack: true,
			})

			// Update targetPath to point to the worktree
			targetPath = worktreePath

			// Load config for emit pattern calculation
			const configForDisplay = yield* configService.loadConfig()
			const cleanBranchForDisplay =
				extractCleanBranch(
					sourceBranchName,
					configForDisplay.sourceBranchPattern,
				) || sourceBranchName
			const emitBranchForDisplay = makeEmitBranchName(
				cleanBranchForDisplay,
				configForDisplay.emitBranch,
			)

			log(
				info(
					baseBranchToBranchFrom
						? `(${highlight.branch(baseBranchToBranchFrom)}) ${highlight.branch(sourceBranchName)} → ${highlight.branch(emitBranchForDisplay)}`
						: `${highlight.branch(sourceBranchName)} → ${highlight.branch(emitBranchForDisplay)}`,
				),
			)
			log(
				done(
					`Created worktree at ${highlight.file(AGENCY_WORKTREES_DIR + "/" + branchCleanName)}`,
				),
			)
		} else if (sourceBranchName) {
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

			// Check if this file is in a subdirectory that doesn't exist yet
			// If so, we'll track it for glob pattern creation
			const topLevelDir = getTopLevelDir(fileName)
			if (topLevelDir && source === "template") {
				const dirPath = resolve(targetPath, topLevelDir)
				const dirExists = yield* fs.exists(dirPath)
				if (!dirExists) {
					createdDirs.add(topLevelDir)
					verboseLog(`Will create new directory: ${topLevelDir}`)
				}
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

			// Ensure parent directory exists before writing file
			const parentDir = dirname(targetFilePath)
			const parentExists = yield* fs.exists(parentDir)
			if (!parentExists) {
				yield* fs.createDirectory(parentDir)
			}

			yield* fs.writeFile(targetFilePath, content)
			createdFiles.push(fileName)

			// Track backpack files (excluding TASK.md and AGENCY.md which are always filtered)
			// For files in new directories, the glob pattern will be added below
			if (fileName !== "TASK.md" && fileName !== "AGENCY.md") {
				// Only track individual files if they're NOT in a newly created directory
				// (directories will be tracked as glob patterns)
				if (!topLevelDir || !createdDirs.has(topLevelDir)) {
					injectedFiles.push(fileName)
				}
			}

			log(done(`Created ${highlight.file(fileName)}`))
		}

		// Handle CLAUDE.md injection
		// If CLAUDE.md is created (new file), include it in main commit and add to injectedFiles
		// If CLAUDE.md is modified (existing file), commit separately with AGENCY_REMOVE_COMMIT marker
		// so it can be completely removed during emission
		const claudeResult = yield* claudeService.injectAgencySection(targetPath)
		let claudeModifiedExisting = false
		if (claudeResult.created) {
			createdFiles.push("CLAUDE.md")
			injectedFiles.push("CLAUDE.md")
			log(done(`Created ${highlight.file("CLAUDE.md")}`))
		} else if (claudeResult.modified) {
			// Mark that we need a separate commit for CLAUDE.md modification
			claudeModifiedExisting = true
			log(done(`Updated ${highlight.file("CLAUDE.md")}`))
		}

		// Auto-detect base branch for this feature branch
		let baseBranch: string | undefined

		// Check repository-level default in git config
		baseBranch =
			(yield* git.getDefaultBaseBranchConfig(targetPath)) || undefined

		// If no repo-level default, try to auto-detect (preferring remote)
		if (!baseBranch) {
			baseBranch = (yield* git.resolveMainBranch(targetPath)) || undefined
		}

		if (baseBranch) {
			verboseLog(`Auto-detected base branch: ${highlight.branch(baseBranch)}`)
		}

		// Calculate emitBranch name from current branch
		const finalBranch = yield* git.getCurrentBranch(targetPath)
		// Extract clean branch name from source pattern, or use branch as-is for legacy branches
		const cleanBranch =
			extractCleanBranch(finalBranch, config.sourceBranchPattern) || finalBranch
		const emitBranchName = makeEmitBranchName(cleanBranch, config.emitBranch)

		// Convert created directories to glob patterns and add to injectedFiles
		// This allows filtering all files in new directories during emit
		for (const dir of createdDirs) {
			const globPattern = dirToGlobPattern(dir)
			injectedFiles.push(globPattern)
			verboseLog(`Tracking directory as glob pattern: ${globPattern}`)
		}

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

		// Format created files using project's formatter (prettier/oxfmt)
		const formatterService = yield* FormatterService
		yield* formatterService.formatFiles(targetPath, createdFiles, verboseLog)

		// Git add and commit the created files
		if (createdFiles.length > 0) {
			yield* Effect.gen(function* () {
				yield* git.gitAdd(createdFiles, targetPath)
				// Format: chore: agency task (baseBranch) sourceBranch → emitBranch
				const commitMessage = baseBranch
					? `chore: agency task (${baseBranch}) ${finalBranch} → ${emitBranchName}`
					: `chore: agency task ${finalBranch} → ${emitBranchName}`
				yield* git.gitCommit(commitMessage, targetPath, {
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

		// Create separate commit for CLAUDE.md modification with AGENCY_REMOVE_COMMIT marker
		// This commit will be completely removed during emission
		if (claudeModifiedExisting) {
			yield* Effect.gen(function* () {
				// Check if CLAUDE.md is a symlink - if so, we need to add both the symlink
				// and its target file, since git add on a symlink only stages the symlink itself
				const claudePath = resolve(targetPath, "CLAUDE.md")
				const filesToAdd = ["CLAUDE.md"]

				const symlinkTarget = yield* fs.readSymlinkTarget(claudePath)
				if (symlinkTarget) {
					// Symlink target can be relative or absolute
					// If relative, resolve it relative to the symlink's directory
					const resolvedTarget = symlinkTarget.startsWith("/")
						? symlinkTarget
						: resolve(targetPath, symlinkTarget)

					// Make the path relative to targetPath for git add
					const relativeTarget = resolvedTarget.startsWith(targetPath)
						? resolvedTarget.slice(targetPath.length + 1)
						: resolvedTarget

					filesToAdd.push(relativeTarget)
					verboseLog(
						`CLAUDE.md is a symlink to ${relativeTarget}, adding both files`,
					)
				}

				yield* git.gitAdd(filesToAdd, targetPath)
				// The AGENCY_REMOVE_COMMIT marker in the commit body tells emit to drop this commit entirely
				const commitMessage = `chore: agency edit CLAUDE.md\n\n${AGENCY_REMOVE_COMMIT}`
				yield* git.gitCommit(commitMessage, targetPath, {
					noVerify: true,
				})
				verboseLog(
					"Created CLAUDE.md modification commit (will be removed on emit)",
				)
			}).pipe(
				Effect.catchAll((err) => {
					verboseLog(`Failed to commit CLAUDE.md modification: ${err}`)
					return Effect.void
				}),
			)
		}

		// Execute worktree-init script if this is a worktree task
		if (options.worktree && templateName) {
			const templateDir = yield* templateService.getTemplateDir(templateName)
			yield* executeWorktreeInit(
				templateDir,
				targetPath,
				yield* git.getCurrentBranch(targetPath),
				branchName!,
				mainRepoRoot,
				templateName,
				options,
			)

			// Print the worktree path for the user to cd into
			log("")
			log(info(`cd ${targetPath}`))
		}
	})

// Helper: Ensure .agency-worktrees/ is in .git/info/exclude
const ensureWorktreeExclude = (mainRepoRoot: string) =>
	Effect.gen(function* () {
		const git = yield* GitService
		const fs = yield* FileSystemService

		const commonGitDir = yield* git.getCommonGitDir(mainRepoRoot)
		const excludeFile = resolve(commonGitDir, "info", "exclude")
		const excludeEntry = AGENCY_WORKTREES_DIR + "/"

		// Ensure info directory exists
		const infoDir = resolve(commonGitDir, "info")
		const infoDirExists = yield* fs.exists(infoDir)
		if (!infoDirExists) {
			yield* fs.createDirectory(infoDir)
		}

		// Read existing exclude file
		const exists = yield* fs.exists(excludeFile)
		let content = ""
		if (exists) {
			content = yield* fs.readFile(excludeFile)
		}

		// Check if the exclude entry already exists
		const lines = content.split("\n")
		if (lines.some((line) => line.trim() === excludeEntry)) {
			return // Already excluded
		}

		// Append the exclude entry
		const newContent =
			content.endsWith("\n") || content === ""
				? content + excludeEntry + "\n"
				: content + "\n" + excludeEntry + "\n"

		yield* fs.writeFile(excludeFile, newContent)
	})

// Helper: Execute worktree-init script from template if it exists
const executeWorktreeInit = (
	templateDir: string,
	worktreePath: string,
	sourceBranchName: string,
	taskName: string,
	mainRepoRoot: string,
	templateName: string,
	options: { silent?: boolean; verbose?: boolean },
) =>
	Effect.gen(function* () {
		const fs = yield* FileSystemService
		const { log, verboseLog } = createLoggers(options)

		const initScript = join(templateDir, WORKTREE_INIT_SCRIPT)
		const scriptExists = yield* fs.exists(initScript)

		if (!scriptExists) {
			verboseLog(`No ${WORKTREE_INIT_SCRIPT} script in template`)
			return
		}

		verboseLog(`Executing ${WORKTREE_INIT_SCRIPT} from template`)

		const result = yield* spawnProcess(["bash", initScript], {
			cwd: worktreePath,
			stdout: "inherit",
			stderr: "inherit",
			env: {
				AGENCY_WORKTREE_PATH: worktreePath,
				AGENCY_BRANCH: sourceBranchName,
				AGENCY_TASK_NAME: taskName,
				AGENCY_MAIN_REPO: mainRepoRoot,
				AGENCY_TEMPLATE: templateName,
			},
		})

		if (result.exitCode !== 0) {
			log(info(`${WORKTREE_INIT_SCRIPT} exited with code ${result.exitCode}`))
		} else {
			log(done(`Executed ${highlight.file(WORKTREE_INIT_SCRIPT)}`))
		}
	}).pipe(
		Effect.catchAll((err) => {
			const { verboseLog } = createLoggers(options)
			verboseLog(`Failed to execute ${WORKTREE_INIT_SCRIPT}: ${err}`)
			return Effect.void
		}),
	)

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

		// Use provided base branch if available, otherwise resolve (preferring remote)
		let baseBranch: string | undefined = providedBaseBranch

		if (!baseBranch) {
			baseBranch = (yield* git.resolveMainBranch(targetPath)) || undefined
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

		// Load config for emit pattern calculation
		const configService = yield* ConfigService
		const config = yield* configService.loadConfig()

		// Calculate the emit branch name for display
		const cleanBranchForDisplay =
			extractCleanBranch(branchName, config.sourceBranchPattern) || branchName
		const emitBranchForDisplay = makeEmitBranchName(
			cleanBranchForDisplay,
			config.emitBranch,
		)

		log(
			info(
				baseBranch
					? `(${highlight.branch(baseBranch)}) ${highlight.branch(branchName)} → ${highlight.branch(emitBranchForDisplay)}`
					: `${highlight.branch(branchName)} → ${highlight.branch(emitBranchForDisplay)}`,
			),
		)
		log(done(`Created and switched to ${highlight.branch(branchName)}`))
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

		const fs = yield* FileSystemService
		const git = yield* GitService

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
		// On macOS, use 'open -W' to wait for the editor to close
		const editor =
			process.env.VISUAL ||
			process.env.EDITOR ||
			(process.platform === "darwin" ? "open" : "vim")

		verboseLog(`Using editor: ${editor}`)

		// Build the command array
		// If using 'open' on macOS, add -W flag to wait for the app to close
		const editorCommand =
			editor === "open" ? [editor, "-W", taskFilePath] : [editor, taskFilePath]

		// Use interactive mode for editors that need terminal access (stdin/stdout/stderr)
		// 'open' on macOS launches a separate app, so it doesn't need interactive mode
		const result = yield* fs.runCommand(editorCommand, {
			interactive: editor !== "open",
		})

		if (result.exitCode !== 0) {
			return yield* Effect.fail(
				new Error(`Editor exited with code ${result.exitCode}`),
			)
		}

		log(done("TASK.md edited"))

		// Check if TASK.md has uncommitted changes
		const hasChanges = yield* git.hasUncommittedChanges(gitRoot, "TASK.md")
		verboseLog(`TASK.md has uncommitted changes: ${hasChanges}`)

		if (hasChanges) {
			// Commit the changes
			yield* Effect.gen(function* () {
				yield* git.gitAdd(["TASK.md"], gitRoot)
				yield* git.gitCommit("chore: agency edit", gitRoot, {
					noVerify: true,
				})
				log(done("Committed TASK.md changes"))
			}).pipe(
				Effect.catchAll((err) => {
					verboseLog(`Failed to commit TASK.md: ${err}`)
					return Effect.void
				}),
			)
		}
	})

export const editHelp = `
Usage: agency edit [options]

Open TASK.md in the system editor for editing.

Notes:
  - Requires TASK.md to exist (run 'agency task' first)
  - Respects VISUAL and EDITOR environment variables
  - On macOS, defaults to 'open' which uses the default app for .md files
  - On other platforms, defaults to 'vim'
  - The command waits for the editor to close before returning

Example:
  agency edit                   # Open TASK.md in default editor
`

export const help = `
Usage: agency task <branch-name> [options]

Initialize template files (AGENTS.md, TASK.md, opencode.json) in a git repository.

IMPORTANT: 
  - You must run 'agency init' first to select a template
  - A branch name is required (creates a new branch from the latest origin/main)

Arguments:
  branch-name       Name for the new feature branch (required)

Options:
  --emit            Branch name to create (alternative to positional arg)
  --branch          (Deprecated: use --emit) Branch name to create
  --from <branch>   Branch to branch from instead of main upstream branch
  --from-current    Initialize on current branch instead of creating a new one
  --continue        Continue a task by copying agency files to a new branch
  --squash          With --continue: squash the old branch's emitted commits into one
  --task <desc>     Task description for TASK.md (avoids interactive prompt)
  -w, --worktree    Create a git worktree instead of switching branches

Continue Mode (--continue):
  After a PR is merged, use '--continue' to create a new branch that preserves
  your agency files (TASK.md, AGENCY.md, opencode.json, agency.json, and all
  backpacked files). This allows you to continue working on a task after its
  PR has been merged to main.
  
  The continue workflow:
  1. Be on an agency source branch with agency files
  2. Run 'agency task --continue <new-branch-name>'
  3. A new branch is created from main with all your agency files
  4. The emitBranch in agency.json is updated for the new branch

Squash Mode (--continue --squash):
  Combines --continue with squashing the old branch's emitted commits into a
  single commit on the new branch. This is useful when you want to carry forward
  code changes but collapse the commit history. A fresh TASK.md is created with
  a new task description.
  
  The squash workflow:
  1. Be on an agency source branch with agency files
  2. Run 'agency task --continue --squash <new-branch-name>'
  3. The old branch is emitted (backpack files stripped)
  4. A new branch is created from main
  5. The emitted commits are squash-merged as a single commit
  6. Fresh agency files (including new TASK.md) are added

Worktree Mode (-w, --worktree):
  Creates a git worktree at .agency-worktrees/<branch>/ so you can work on
  multiple tasks in parallel without switching branches. The directory is
  locally excluded from git via .git/info/exclude.

  If your template includes a 'worktree-init' script, it will be executed
  after setup with environment variables: AGENCY_WORKTREE_PATH, AGENCY_BRANCH,
  AGENCY_TASK_NAME, AGENCY_MAIN_REPO, AGENCY_TEMPLATE.

Base Branch Selection:
  By default, 'agency task' fetches from the remote and branches from the latest
  main upstream branch (e.g., origin/main). You can override this behavior with:
  
  - --from <branch>: Branch from a specific branch
  - --from-current: Initialize on your current branch (no new branch created)
  
  If the base branch is an agency source branch (e.g., agency--branch-A), the command
  will automatically use its emit branch instead. This allows you to layer work on top
  of other feature branches while maintaining clean branch history.

Examples:
  agency task my-feature               # Create 'my-feature' from latest origin/main
  agency task my-feature --from develop # Create 'my-feature' from 'develop'
  agency task --from-current           # Initialize on current branch (no new branch)
  agency task -w my-feature            # Create 'my-feature' in a worktree
  agency task --continue my-feature-v2 # Continue task on new branch after PR merge

Template Workflow:
  1. Run 'agency init' to select template (saved to .git/config)
  2. Run 'agency task <branch-name>' to create feature branch with template files
  3. Use 'agency template save <file>' to update template with local changes
  4. Template directory only created when you save files to it

Branch Creation:
  When creating a new branch without --from or --from-current:
  1. Fetches from the configured remote (or origin)
  2. Auto-detects main upstream branch (origin/main, origin/master, etc.)
  3. Creates new branch from the latest remote main branch

Notes:
  - Files are created at the git repository root, not the current directory
  - If files already exist in the repository, they will not be overwritten
  - Template selection is stored in .git/config (not committed)
  - To edit TASK.md after creation, use 'agency edit'
`

export const taskEdit = (options: TaskEditOptions = {}) =>
	taskEditEffect(options)
