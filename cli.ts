#!/usr/bin/env bun

import { parseArgs } from "util"
import { task, taskEdit, help as taskHelp } from "./src/commands/task"
import { pr, help as prHelp } from "./src/commands/pr"
import { set, help as setHelp } from "./src/commands/set"
import { get, help as getHelp } from "./src/commands/get"
import { source, help as sourceHelp } from "./src/commands/source"
import { switchBranch, help as switchHelp } from "./src/commands/switch"
import { merge, help as mergeHelp } from "./src/commands/merge"
import { template, help as templateHelp } from "./src/commands/template"
import type { Command } from "./src/types"
import { setColorsEnabled } from "./src/utils/colors"

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
	set: {
		name: "set",
		description: "Set configuration options",
		run: async (args: string[], options: Record<string, any>) => {
			if (options.help) {
				console.log(setHelp)
				return
			}
			await set({
				subcommand: args[0],
				args: args.slice(1),
				silent: options.silent,
				verbose: options.verbose,
			})
		},
		help: setHelp,
	},
	get: {
		name: "get",
		description: "Get configuration options",
		run: async (args: string[], options: Record<string, any>) => {
			if (options.help) {
				console.log(getHelp)
				return
			}
			await get({
				subcommand: args[0],
				silent: options.silent,
				verbose: options.verbose,
			})
		},
		help: getHelp,
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
			const branch = args[0] || options.branch
			await task({
				branch,
				silent: options.silent,
				verbose: options.verbose,
				template: options.template,
				task: options.task,
			})
		},
		help: taskHelp,
	},
	edit: {
		name: "edit",
		description: "Open TASK.md in system editor",
		run: async (_args: string[], options: Record<string, any>) => {
			if (options.help) {
				console.log(`
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
				`)
				return
			}
			await taskEdit({
				silent: options.silent,
				verbose: options.verbose,
			})
		},
		help: `Open TASK.md in system editor`,
	},
}

function showMainHelp() {
	console.log(`
agency v${VERSION}

Usage: agency <command> [options]

Commands:
   task [branch]          Initialize AGENTS.md and TASK.md files
   edit                   Open TASK.md in system editor
   template <subcommand>  Template management commands
   pr [base-branch]       Create a PR branch without AGENTS.md
   set <subcommand>       Set configuration options
   get <subcommand>       Get configuration options
  source                 Switch back to source branch from PR branch
  switch                 Toggle between source and PR branch
  merge                  Merge PR branch into base branch

Global Options:
  -h, --help             Show help for a command
  -v, --version          Show version number
  --no-color             Disable color output

Command Options:
  -s, --silent           Suppress output messages
  -f, --force            Force operation (pr command only)
  -v, --verbose          Show verbose output including detailed debugging info
  -t, --template         Specify template name (task command only)

Examples:
  agency task                         # Initialize in current directory
  agency task my-feature              # Create 'my-feature' branch and initialize
  agency pr                           # Create PR branch (prompts for base branch)
  agency switch                       # Toggle between source and PR branch

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
