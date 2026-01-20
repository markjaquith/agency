import { join } from "node:path"
import { Effect } from "effect"
import type { BaseCommandOptions } from "../utils/command"
import { FileSystemService } from "../services/FileSystemService"
import { GitService } from "../services/GitService"
import { createLoggers, ensureGitRepo } from "../utils/effect"
import { spawnProcess } from "../utils/process"
import {
	parseTaskItems,
	countTasks,
	areAllTasksComplete,
	extractCompletionPromise,
	validateCompletion,
} from "../utils/task-parser"
import highlight, { done, info } from "../utils/colors"

interface LoopOptions extends BaseCommandOptions {
	/**
	 * Maximum number of iterations (undefined = unlimited)
	 */
	maxLoops?: number
	/**
	 * Minimum number of iterations to enforce
	 */
	minLoops?: number
	/**
	 * Force use of OpenCode CLI
	 */
	opencode?: boolean
	/**
	 * Force use of Claude Code CLI
	 */
	claude?: boolean
}

interface LoopState {
	iteration: number
	tasksCompleted: number
	tasksIncomplete: number
	tasksTotalAtStart: number
	iterationStartTime: number
	harnessFailed: boolean
}

export const loop = (options: LoopOptions = {}) =>
	Effect.gen(function* () {
		const { log, verboseLog } = createLoggers(options)
		const fs = yield* FileSystemService

		const gitRoot = yield* ensureGitRepo()

		// Check if TASK.md exists
		const taskPath = join(gitRoot, "TASK.md")
		const taskExists = yield* fs.exists(taskPath)
		if (!taskExists) {
			return yield* Effect.fail(
				new Error("TASK.md not found. Run 'agency task' first to create it."),
			)
		}

		verboseLog(`Found TASK.md at: ${taskPath}`)

		// Change to git root before executing and restore afterwards
		// Do not change global cwd; pass gitRoot explicitly to subprocesses

		// Check for conflicting flags
		if (options.opencode && options.claude) {
			return yield* Effect.fail(
				new Error(
					"Cannot use both --opencode and --claude flags together. Choose one.",
				),
			)
		}

		// Validate loop bounds
		if (
			typeof options.minLoops === "number" &&
			typeof options.maxLoops === "number" &&
			options.minLoops > options.maxLoops
		) {
			return yield* Effect.fail(
				new Error("--min-loops cannot be greater than --max-loops."),
			)
		}

		// Check which CLI tool is available
		const hasOpencode = yield* Effect.tryPromise({
			try: async () => {
				const result = Bun.spawnSync(["which", "opencode"], {
					stdout: "ignore",
					stderr: "ignore",
				})
				return result.exitCode === 0
			},
			catch: () => false,
		})

		const hasClaude = yield* Effect.tryPromise({
			try: async () => {
				const result = Bun.spawnSync(["which", "claude"], {
					stdout: "ignore",
					stderr: "ignore",
				})
				return result.exitCode === 0
			},
			catch: () => false,
		})

		// Determine which CLI to use based on flags or auto-detection
		let useOpencode: boolean
		if (options.opencode) {
			if (!hasOpencode) {
				return yield* Effect.fail(
					new Error(
						"opencode CLI tool not found. Please install OpenCode or remove the --opencode flag.",
					),
				)
			}
			useOpencode = true
			verboseLog("Using opencode (explicitly requested)")
		} else if (options.claude) {
			if (!hasClaude) {
				return yield* Effect.fail(
					new Error(
						"claude CLI tool not found. Please install Claude Code or remove the --claude flag.",
					),
				)
			}
			useOpencode = false
			verboseLog("Using claude (explicitly requested)")
		} else {
			// Auto-detect
			if (!hasOpencode && !hasClaude) {
				return yield* Effect.fail(
					new Error(
						"Neither opencode nor claude CLI tool found. Please install OpenCode or Claude Code.",
					),
				)
			}
			useOpencode = hasOpencode
			verboseLog(`Using ${useOpencode ? "opencode" : "claude"} (auto-detected)`)
		}

		const cliName = useOpencode ? "opencode" : "claude"

		// Parse initial task state
		let taskContent = yield* fs.readFile(taskPath)
		let taskItems = parseTaskItems(taskContent)
		let taskCounts = countTasks(taskItems)
		const tasksTotalAtStart = taskCounts.total

		// If there are no tasks at all, treat as complete but still respect minLoops
		const noTasks = tasksTotalAtStart === 0

		verboseLog(
			`Initial state: ${taskCounts.completed}/${taskCounts.total} tasks complete`,
		)

		const loopStartTime = Date.now()
		let loopState: LoopState = {
			iteration: 0,
			tasksCompleted: taskCounts.completed,
			tasksIncomplete: taskCounts.incomplete,
			tasksTotalAtStart,
			iterationStartTime: loopStartTime,
			harnessFailed: false,
		}

		// Main loop
		while (true) {
			loopState.iteration++
			loopState.iterationStartTime = Date.now()
			loopState.harnessFailed = false

			// Check if we've exceeded max loops
			if (options.maxLoops && loopState.iteration > options.maxLoops) {
				break
			}

			// Log iteration start
			const maxStr = options.maxLoops ? `/${options.maxLoops}` : ""
			const minStr = options.minLoops ? ` (min: ${options.minLoops})` : ""
			log(
				info(
					`Loop ${loopState.iteration}${maxStr}${minStr} - ${loopState.tasksCompleted}/${loopState.tasksTotalAtStart} tasks complete`,
				),
			)

			// Prepare harness command
			const harnessPassed = yield* runHarness(
				cliName,
				useOpencode,
				gitRoot,
				options.verbose ?? false,
				verboseLog,
			).pipe(
				Effect.map(() => true),
				Effect.catchAll(() => Effect.succeed(false)),
			)

			if (!harnessPassed) {
				verboseLog(
					`Harness failed on iteration ${loopState.iteration}, retrying...`,
				)
				loopState.harnessFailed = true
				// Retry once
				const harnessPassed2 = yield* runHarness(
					cliName,
					useOpencode,
					gitRoot,
					options.verbose ?? false,
					verboseLog,
				).pipe(
					Effect.map(() => true),
					Effect.catchAll(() => Effect.succeed(false)),
				)

				if (!harnessPassed2) {
					return yield* Effect.fail(
						new Error(
							`Harness failed twice on iteration ${loopState.iteration}. Stopping loop.`,
						),
					)
				}
			}

			// Re-read TASK.md and check status
			taskContent = yield* fs.readFile(taskPath)
			taskItems = parseTaskItems(taskContent)
			taskCounts = countTasks(taskItems)

			loopState.tasksCompleted = taskCounts.completed
			loopState.tasksIncomplete = taskCounts.incomplete

			const allComplete = noTasks ? true : areAllTasksComplete(taskItems)
			const completionPromise = extractCompletionPromise(taskContent)

			// Validate completion claim if agent says it's done
			if (completionPromise) {
				try {
					validateCompletion(completionPromise, allComplete)
				} catch (error) {
					return yield* Effect.fail(error)
				}
			}

			// Log iteration summary
			const iterationDuration = Date.now() - loopState.iterationStartTime
			const durationSecs = (iterationDuration / 1000).toFixed(1)
			log(
				done(
					`Loop ${loopState.iteration} complete (${durationSecs}s) - ${loopState.tasksCompleted}/${loopState.tasksTotalAtStart} tasks complete`,
				),
			)

			// Check if we should exit
			if (
				allComplete &&
				(!options.minLoops || loopState.iteration >= options.minLoops)
			) {
				// Ensure TASK.md does not contain the completion promise
				const fs = yield* FileSystemService
				const taskPath = `${gitRoot}/TASK.md`
				if (yield* fs.exists(taskPath)) {
					const contents = yield* fs.readFile(taskPath)
					const cleaned =
						contents.replace(/<promise>[^<]*<\/promise>/gi, "").trimEnd() + "\n"
					if (cleaned !== contents) {
						yield* fs.writeFile(taskPath, cleaned)
						// Commit cleanup so final TASK.md is clean
						const git = yield* GitService
						yield* git.gitAdd(["TASK.md"], gitRoot)
						yield* git.gitCommit(
							"fix(loop): remove completion promise from TASK.md",
							gitRoot,
						)
					}
				}
				log(done(`All tasks complete!`))
				break
			}

			// Check if we've hit max loops
			if (options.maxLoops && loopState.iteration >= options.maxLoops) {
				if (!allComplete) {
					log(
						info(
							`Max loops (${options.maxLoops}) reached but tasks remain. Stopping.`,
						),
					)
				}
				break
			}
		}

		// Final summary
		const totalDuration = Date.now() - loopStartTime
		const totalDurationSecs = (totalDuration / 1000).toFixed(1)
		log(
			done(
				`Loop completed in ${loopState.iteration} iteration${loopState.iteration === 1 ? "" : "s"} (${totalDurationSecs}s)`,
			),
		)
		log(
			done(
				`Final state: ${loopState.tasksCompleted}/${loopState.tasksTotalAtStart} tasks complete`,
			),
		)
	})

/**
 * Run the harness (opencode or claude run) for a single iteration
 */
function runHarness(
	cliName: string,
	useOpencode: boolean,
	gitRoot: string,
	verbose: boolean,
	verboseLog: (msg: string) => void,
): Effect.Effect<void, Error> {
	return Effect.gen(function* () {
		const prompt =
			"Find the next logical task from TASK.md and work on it until complete. Update TASK.md with progress, and commit your changes. Once all tasks are done, output <promise>COMPLETE</promise>"

		// opencode: use `opencode run "prompt"` for non-interactive mode
		// claude: use `claude "prompt"` (positional argument)
		const baseArgs = useOpencode ? [cliName, "run", prompt] : [cliName, prompt]

		// Log the command being run when verbose
		// Quote arguments that contain spaces for proper display
		const quotedArgs = baseArgs.map((arg) =>
			arg.includes(" ") ? `"${arg}"` : arg,
		)
		verboseLog(`Running: ${quotedArgs.join(" ")}`)

		// When verbose, stream output directly to the terminal
		// When not verbose, capture output silently
		// Always inherit stdin so the process doesn't hang waiting for input
		const result = yield* spawnProcess(baseArgs, {
			cwd: gitRoot,
			stdin: "inherit",
			stdout: verbose ? "inherit" : "pipe",
			stderr: verbose ? "inherit" : "pipe",
		}).pipe(
			Effect.catchAll((error) =>
				Effect.fail(new Error(`${cliName} exited with error: ${error.stderr}`)),
			),
		)

		if (result.exitCode !== 0) {
			return yield* Effect.fail(
				new Error(`${cliName} exited with code ${result.exitCode}`),
			)
		}
	})
}

export const help = `
Usage: agency loop [options]

Run a Ralph Wiggum loop that repeatedly invokes the harness (opencode or claude)
to work on tasks defined in TASK.md until all tasks are complete.

Each iteration:
1. Invokes the harness with a prompt to work on the next task
2. Checks TASK.md for task completion status
3. Validates completion claims against actual task status
4. Commits changes if any were made
5. Repeats until all tasks are done or max loops reached

Options:
  --max-loops <num>     Maximum number of iterations (default: unlimited)
  --min-loops <num>     Minimum number of iterations (safety check)
  --opencode            Force use of OpenCode CLI
  --claude              Force use of Claude Code CLI
  -h, --help            Show this help message
  -s, --silent          Suppress output messages
  -v, --verbose         Stream harness output to terminal

Examples:
  agency loop                      # Run until all tasks are done
  agency loop --max-loops 5        # Stop after 5 iterations
  agency loop --min-loops 3        # Require at least 3 iterations
  agency loop --min-loops 3 --max-loops 10  # Between 3-10 iterations

Notes:
  - Requires TASK.md to exist (run 'agency task' first)
  - Each iteration calls the harness which handles its own commit
  - The loop validates that completion claims match actual task status
  - Use --min-loops as a safeguard if you know the minimum work required
`
