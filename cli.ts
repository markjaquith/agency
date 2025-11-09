#!/usr/bin/env bun

import { parseArgs } from "util"
import { task, taskEdit, help as taskHelp } from "./src/commands/task"
import { pr, help as prHelp } from "./src/commands/pr"
import { setBase, help as setBaseHelp } from "./src/commands/set-base"
import { source, help as sourceHelp } from "./src/commands/source"
import { switchBranch, help as switchHelp } from "./src/commands/switch"
import { merge, help as mergeHelp } from "./src/commands/merge"
import { template, help as templateHelp } from "./src/commands/template"
import type { Command } from "./src/types"

// Read version from package.json
const packageJson = await Bun.file(
	new URL("./package.json", import.meta.url),
).json()
const VERSION = packageJson.version

// Define commands
const commands: Record<string, Command> = {
	pr: {
		name: "pr",
		description: "Create a PR branch without AGENTS.md",
		run: async (args: string[], options: Record<string, any>) => {
			if (options.help) {
				console.log(prHelp)
				return
			}
			await pr({
				baseBranch: args[0],
				branch: options.branch,
				silent: options.silent,
				force: options.force,
				verbose: options.verbose,
			})
		},
		help: prHelp,
	},
	template: {
		name: "template",
		description: "Template management commands",
		run: async (args: string[], options: Record<string, any>) => {
			if (options.help) {
				console.log(templateHelp)
				return
			}
			await template({
				subcommand: args[0],
				args: args.slice(1),
				silent: options.silent,
				verbose: options.verbose,
				template: options.template,
			})
		},
		help: templateHelp,
	},
	source: {
		name: "source",
		description: "Switch back to source branch from PR branch",
		run: async (args: string[], options: Record<string, any>) => {
			if (options.help) {
				console.log(sourceHelp)
				return
			}
			await source({ silent: options.silent, verbose: options.verbose })
		},
		help: sourceHelp,
	},
	switch: {
		name: "switch",
		description: "Toggle between source and PR branch",
		run: async (_args: string[], options: Record<string, any>) => {
			if (options.help) {
				console.log(switchHelp)
				return
			}
			await switchBranch({ silent: options.silent, verbose: options.verbose })
		},
		help: switchHelp,
	},

	merge: {
		name: "merge",
		description: "Merge PR branch into base branch",
		run: async (_args: string[], options: Record<string, any>) => {
			if (options.help) {
				console.log(mergeHelp)
				return
			}
			await merge({ silent: options.silent, verbose: options.verbose })
		},
		help: mergeHelp,
	},
	"set-base": {
		name: "set-base",
		description: "Set default base branch for current branch",
		run: async (args: string[], options: Record<string, any>) => {
			if (options.help) {
				console.log(setBaseHelp)
				return
			}
			if (!args[0]) {
				throw new Error(
					"Base branch argument is required. Usage: agency set-base <base-branch>",
				)
			}
			await setBase({
				baseBranch: args[0],
				silent: options.silent,
				verbose: options.verbose,
			})
		},
		help: setBaseHelp,
	},
	task: {
		name: "task",
		description: "Task management commands",
		run: async (args: string[], options: Record<string, any>) => {
			if (options.help) {
				console.log(taskHelp)
				return
			}
			const subcommand = args[0]
			if (subcommand === "edit") {
				await taskEdit({
					silent: options.silent,
					verbose: options.verbose,
				})
			} else {
				// Default behavior: initialize (no subcommand or branch name)
				const branch = subcommand || options.branch
				await task({
					branch,
					silent: options.silent,
					verbose: options.verbose,
					template: options.template,
					task: options.task,
				})
			}
		},
		help: taskHelp,
	},
}

function showMainHelp() {
	console.log(`
agency v${VERSION}

Usage: agency <command> [options]

Commands:
   task [branch]          Initialize AGENTS.md and TASK.md files
   task edit              Open TASK.md in system editor
   template <subcommand>  Template management commands
   pr [base-branch]       Create a PR branch without AGENTS.md
   set-base <branch>      Set default base branch for current branch
  source                 Switch back to source branch from PR branch
  switch                 Toggle between source and PR branch
  merge                  Merge PR branch into base branch

Global Options:
  -h, --help             Show help for a command
  -v, --version          Show version number

Command Options:
  -s, --silent           Suppress output messages
  -f, --force            Force operation (pr command only)
  -v, --verbose          Show verbose output including detailed debugging info
  -t, --template         Specify template name (task command only)

Examples:
  agency task                         # Initialize in current directory
  agency task --template=work         # Initialize with specific template
  agency task my-feature              # Create 'my-feature' branch and initialize
  agency task edit                    # Open TASK.md in system editor
  agency template use                 # Interactively select template
  agency template use work            # Set template to 'work'
  agency template save AGENTS.md      # Save specific file to template
  agency template save src/ docs/     # Save directories to template
  agency template save .              # Save current directory contents
  agency pr                           # Create PR branch (prompts for base branch)
  agency pr origin/main               # Create PR branch using origin/main as base
  agency pr --verbose                 # Create PR branch with detailed output
  agency set-base origin/main         # Set default base branch to origin/main
  agency source                       # Switch from PR branch to source branch
  agency switch                       # Toggle between source and PR branch
  agency merge                        # Merge PR branch into base branch
  agency merge --verbose              # Merge with detailed output
  agency task --help                  # Show help for task command
  agency template --help              # Show help for template command
  agency --version                    # Show version number

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
		},
		strict: false,
		allowPositionals: true,
	})

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
			branch: {
				type: "string",
				short: "b",
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
