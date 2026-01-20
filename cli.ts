#!/usr/bin/env bun

import { parseArgs } from "util"
import { Effect, Layer } from "effect"
import { clean, help as cleanHelp } from "./src/commands/clean"
import { init, help as initHelp } from "./src/commands/init"
import { task, taskEdit, help as taskHelp, editHelp } from "./src/commands/task"
import { tasks, help as tasksHelp } from "./src/commands/tasks"
import { emit, help as emitHelp } from "./src/commands/emit"
import { emitted, help as emittedHelp } from "./src/commands/emitted"
import { push, help as pushHelp } from "./src/commands/push"
import { pull, help as pullHelp } from "./src/commands/pull"
import { rebase, help as rebaseHelp } from "./src/commands/rebase"
import { base, help as baseHelp } from "./src/commands/base"
import { switchBranch, help as switchHelp } from "./src/commands/switch"
import { source, help as sourceHelp } from "./src/commands/source"
import { merge, help as mergeHelp } from "./src/commands/merge"
import { template, help as templateHelp } from "./src/commands/template"
import { work, help as workHelp } from "./src/commands/work"
import { loop, help as loopHelp } from "./src/commands/loop"
import { status, help as statusHelp } from "./src/commands/status"
import type { Command } from "./src/types"
import { setColorsEnabled } from "./src/utils/colors"
import { GitService } from "./src/services/GitService"
import { ConfigService } from "./src/services/ConfigService"
import { FileSystemService } from "./src/services/FileSystemService"
import { PromptService } from "./src/services/PromptService"
import { TemplateService } from "./src/services/TemplateService"
import { OpencodeService } from "./src/services/OpencodeService"
import { ClaudeService } from "./src/services/ClaudeService"

// Create CLI layer with all services
const CliLayer = Layer.mergeAll(
	GitService.Default,
	ConfigService.Default,
	FileSystemService.Default,
	PromptService.Default,
	TemplateService.Default,
	OpencodeService.Default,
	ClaudeService.Default,
)

/**
 * Run a command Effect with all services provided
 */
async function runCommand<E>(
	effect: Effect.Effect<void, E, any>,
): Promise<void> {
	const providedEffect = Effect.provide(effect, CliLayer) as Effect.Effect<
		void,
		E,
		never
	>
	const program = Effect.catchAllDefect(providedEffect, (defect) =>
		Effect.fail(defect instanceof Error ? defect : new Error(String(defect))),
	) as Effect.Effect<void, E | Error, never>

	await Effect.runPromise(program)
}

// Read version from package.json
const packageJson = await Bun.file(
	new URL("./package.json", import.meta.url),
).json()
const VERSION = packageJson.version

// Define commands
const commands: Record<string, Command> = {
	init: {
		name: "init",
		description: "Initialize agency with template selection",
		run: async (_args: string[], options: Record<string, any>) => {
			if (options.help) {
				console.log(initHelp)
				return
			}
			await runCommand(
				init({
					template: options.template,
					silent: options.silent,
					verbose: options.verbose,
				}),
			)
		},
		help: initHelp,
	},
	emit: {
		name: "emit",
		description: "Emit a branch without backpack files",
		run: async (args: string[], options: Record<string, any>) => {
			if (options.help) {
				console.log(emitHelp)
				return
			}
			await runCommand(
				emit({
					baseBranch: args[0],
					emit: options.emit || options.branch,
					silent: options.silent,
					force: options.verbose,
					verbose: options.verbose,
				}),
			)
		},
		help: emitHelp,
	},
	emitted: {
		name: "emitted",
		description: "Get the name of the emitted branch",
		run: async (_args: string[], options: Record<string, any>) => {
			if (options.help) {
				console.log(emittedHelp)
				return
			}
			await runCommand(
				emitted({ silent: options.silent, verbose: options.verbose }),
			)
		},
		help: emittedHelp,
	},
	push: {
		name: "push",
		description: "Emit, push to remote, return to source",
		run: async (args: string[], options: Record<string, any>) => {
			if (options.help) {
				console.log(pushHelp)
				return
			}
			await runCommand(
				push({
					baseBranch: args[0],
					emit: options.emit || options.branch,
					silent: options.silent,
					force: options.force,
					verbose: options.verbose,
					pr: options.pr,
				}),
			)
		},
		help: pushHelp,
	},
	pull: {
		name: "pull",
		description: "Pull commits from remote emit branch to source",
		run: async (_args: string[], options: Record<string, any>) => {
			if (options.help) {
				console.log(pullHelp)
				return
			}
			await runCommand(
				pull({
					remote: options.remote,
					silent: options.silent,
					verbose: options.verbose,
				}),
			)
		},
		help: pullHelp,
	},
	rebase: {
		name: "rebase",
		description: "Rebase source branch onto base branch",
		run: async (args: string[], options: Record<string, any>) => {
			if (options.help) {
				console.log(rebaseHelp)
				return
			}
			await runCommand(
				rebase({
					baseBranch: args[0],
					emit: options.emit || options.branch,
					silent: options.silent,
					verbose: options.verbose,
				}),
			)
		},
		help: rebaseHelp,
	},
	template: {
		name: "template",
		description: "Template management commands",
		run: async (args: string[], options: Record<string, any>) => {
			if (options.help) {
				console.log(templateHelp)
				return
			}
			await runCommand(
				template({
					subcommand: args[0],
					args: args.slice(1),
					silent: options.silent,
					verbose: options.verbose,
					template: options.template,
				}),
			)
		},
		help: templateHelp,
	},
	base: {
		name: "base",
		description: "Get or set the base branch",
		run: async (args: string[], options: Record<string, any>) => {
			if (options.help) {
				console.log(baseHelp)
				return
			}
			await runCommand(
				base({
					subcommand: args[0],
					args: args.slice(1),
					repo: options.repo,
					silent: options.silent,
					verbose: options.verbose,
				}),
			)
		},
		help: baseHelp,
	},
	switch: {
		name: "switch",
		description: "Toggle between source and emitted branch",
		run: async (_args: string[], options: Record<string, any>) => {
			if (options.help) {
				console.log(switchHelp)
				return
			}
			await runCommand(
				switchBranch({ silent: options.silent, verbose: options.verbose }),
			)
		},
		help: switchHelp,
	},
	source: {
		name: "source",
		description: "Switch to source branch from emitted branch",
		run: async (_args: string[], options: Record<string, any>) => {
			if (options.help) {
				console.log(sourceHelp)
				return
			}
			await runCommand(
				source({ silent: options.silent, verbose: options.verbose }),
			)
		},
		help: sourceHelp,
	},
	merge: {
		name: "merge",
		description: "Merge emitted branch into base branch",
		run: async (_args: string[], options: Record<string, any>) => {
			if (options.help) {
				console.log(mergeHelp)
				return
			}
			await runCommand(
				merge({
					silent: options.silent,
					verbose: options.verbose,
					squash: options.squash,
					push: options.push,
				}),
			)
		},
		help: mergeHelp,
	},
	task: {
		name: "task",
		description: "Task management commands",
		run: async (args: string[], options: Record<string, any>) => {
			if (options.help) {
				console.log(taskHelp)
				return
			}
			// Initialize with optional branch name
			const branch = args[0] || options.emit || options.branch
			await runCommand(
				task({
					emit: branch,
					silent: options.silent,
					verbose: options.verbose,
					task: options.task,
					from: options.from,
					fromCurrent: options["from-current"],
					continue: options.continue,
				}),
			)
		},
		help: taskHelp,
	},
	tasks: {
		name: "tasks",
		description: "List all task branches",
		run: async (_args: string[], options: Record<string, any>) => {
			if (options.help) {
				console.log(tasksHelp)
				return
			}
			await runCommand(
				tasks({
					silent: options.silent,
					verbose: options.verbose,
					json: options.json,
				}),
			)
		},
		help: tasksHelp,
	},
	edit: {
		name: "edit",
		description: "Open TASK.md in system editor",
		run: async (_args: string[], options: Record<string, any>) => {
			if (options.help) {
				console.log(editHelp)
				return
			}
			await runCommand(
				taskEdit({
					silent: options.silent,
					verbose: options.verbose,
				}),
			)
		},
		help: editHelp,
	},
	work: {
		name: "work",
		description: "Start working on TASK.md with OpenCode",
		run: async (args: string[], options: Record<string, any>) => {
			if (options.help) {
				console.log(workHelp)
				return
			}

			// Extract extra args (anything after --)
			// Note: parseArgs with strict:false and allowPositionals:true will put
			// args after -- in the positionals array
			const extraArgs = args.length > 0 ? args : undefined

			await runCommand(
				work({
					silent: options.silent,
					verbose: options.verbose,
					opencode: options.opencode,
					claude: options.claude,
					extraArgs,
				}),
			)
		},
		help: workHelp,
	},
	status: {
		name: "status",
		description: "Show agency status for this repository",
		run: async (_args: string[], options: Record<string, any>) => {
			if (options.help) {
				console.log(statusHelp)
				return
			}
			await runCommand(
				status({
					silent: options.silent,
					verbose: options.verbose,
					json: options.json,
				}),
			)
		},
		help: statusHelp,
	},
	clean: {
		name: "clean",
		description: "Delete branches merged into a specified branch",
		run: async (_args: string[], options: Record<string, any>) => {
			if (options.help) {
				console.log(cleanHelp)
				return
			}
			await runCommand(
				clean({
					silent: options.silent,
					verbose: options.verbose,
					dryRun: options["dry-run"],
					mergedInto: options["merged-into"],
				}),
			)
		},
		help: cleanHelp,
	},
	loop: {
		name: "loop",
		description: "Run a Ralph Wiggum loop to complete all tasks",
		run: async (_args: string[], options: Record<string, any>) => {
			if (options.help) {
				console.log(loopHelp)
				return
			}
			await runCommand(
				loop({
					silent: options.silent,
					verbose: options.verbose,
					maxLoops: options["max-loops"],
					minLoops: options["min-loops"],
					opencode: options.opencode,
					claude: options.claude,
				}),
			)
		},
		help: loopHelp,
	},
}

function showMainHelp() {
	console.log(`
agency v${VERSION}

Usage: agency <command> [options]

Commands:
  init                   Initialize agency with template selection (run first)
  task [branch]          Initialize template files on a feature branch
  tasks                  List all task branches
  edit                   Open TASK.md in system editor
  work                   Start working on TASK.md with OpenCode
  template               Template management commands
    use [template]         Set template for this repository
    save <file|dir> ...    Save files/dirs to configured template
    list                   List all files in configured template
    view <file>            View contents of a file in template
    delete <file> ...      Delete files from configured template
  emit [base-branch]     Emit a branch with backpack files reverted
  emitted                Get the name of the emitted branch
  push [base-branch]     Emit, push to remote, return to source
  pull                   Pull commits from remote emit branch to source
  rebase [base-branch]   Rebase source branch onto base branch
  base                   Get or set the base branch
    set <branch>           Set the base branch for the current feature branch
    get                    Get the configured base branch
  switch                 Toggle between source and emitted branch
  source                 Switch to source branch from emitted branch
  merge                  Merge emitted branch into base branch
  status                 Show agency status for this repository

Global Options:
  -h, --help             Show help for a command
  -v, --version          Show version number
  --no-color             Disable color output
  -s, --silent           Suppress output messages
  -v, --verbose          Show verbose output including detailed debugging info

Examples:
  agency init                         # Initialize with template (run first)
  agency task my-feature              # Create 'my-feature' branch from origin/main
  agency task --from-current          # Initialize on current feature branch
  agency emit                         # Emit a branch (prompts for base branch)
  agency switch                       # Toggle between source and emitted branch

For more information about a command, run:
  agency <command> --help
	`)
}

// Parse global arguments
try {
	const { values, positionals } = parseArgs({
		args: process.argv.slice(2),
		options: {
			help: {
				type: "boolean",
				short: "h",
			},
			version: {
				type: "boolean",
				short: "v",
			},
			"no-color": {
				type: "boolean",
			},
		},
		strict: false,
		allowPositionals: true,
	})

	// Handle --no-color flag
	if (values["no-color"]) {
		setColorsEnabled(false)
	}

	// Handle global flags
	if (values.version) {
		console.log(`v${VERSION}`)
		process.exit(0)
	}

	// Get command
	const commandName = positionals[0]

	// Show help if no command
	if (!commandName) {
		showMainHelp()
		process.exit(1)
	}

	// Show main help if --help with no command
	if (values.help && !commandName) {
		showMainHelp()
		process.exit(0)
	}

	// Check if command exists
	const command = commands[commandName]
	if (!command) {
		console.error(`Error: Unknown command '${commandName}'`)
		console.error("\nRun 'agency --help' for usage information.")
		process.exit(1)
	}

	// Parse command-specific arguments
	const commandArgs = process.argv.slice(3)
	const { values: cmdValues, positionals: cmdPositionals } = parseArgs({
		args: commandArgs,
		options: {
			help: {
				type: "boolean",
				short: "h",
			},
			silent: {
				type: "boolean",
				short: "s",
			},
			force: {
				type: "boolean",
				short: "f",
			},
			verbose: {
				type: "boolean",
				short: "v",
			},
			template: {
				type: "string",
				short: "t",
			},
			emit: {
				type: "string",
			},
			branch: {
				type: "string",
			},
			task: {
				type: "string",
			},
			from: {
				type: "string",
			},
			"from-current": {
				type: "boolean",
			},
			continue: {
				type: "boolean",
			},
			json: {
				type: "boolean",
			},
			repo: {
				type: "boolean",
			},
			pr: {
				type: "boolean",
			},
			squash: {
				type: "boolean",
			},
			push: {
				type: "boolean",
			},
			remote: {
				type: "string",
				short: "r",
			},
			"merged-into": {
				type: "string",
			},
			"dry-run": {
				type: "boolean",
			},
			opencode: {
				type: "boolean",
			},
			claude: {
				type: "boolean",
			},
		},
		strict: false,
		allowPositionals: true,
	})

	// Run the command
	await command.run(cmdPositionals, cmdValues)
} catch (error) {
	if (error instanceof Error) {
		console.error(`ⓘ ${error.message}`)
	} else {
		console.error("An unexpected error occurred:", error)
	}
	process.exit(1)
}
