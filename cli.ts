#!/usr/bin/env bun

import { parseArgs } from "util"
import { init, help as initHelp } from "./src/commands/init"
import { pr, help as prHelp } from "./src/commands/pr"
import { save, help as saveHelp } from "./src/commands/save"
import { source, help as sourceHelp } from "./src/commands/source"
import { switchBranch, help as switchHelp } from "./src/commands/switch"
import { use, help as useHelp } from "./src/commands/use"
import type { Command } from "./src/types"

// Read version from package.json
const packageJson = await Bun.file(
	new URL("./package.json", import.meta.url),
).json()
const VERSION = packageJson.version

// Define commands
const commands: Record<string, Command> = {
	init: {
		name: "init",
		description: "Initialize AGENTS.md file",
		run: async (args: string[], options: Record<string, any>) => {
			if (options.help) {
				console.log(initHelp)
				return
			}
			// args[0] is always treated as a branch name
			const branch = args[0] || options.branch

			await init({
				branch,
				silent: options.silent,
				verbose: options.verbose,
				template: options.template,
			})
		},
		help: initHelp,
	},
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
	save: {
		name: "save",
		description: "Save files to configured template",
		run: async (args: string[], options: Record<string, any>) => {
			if (options.help) {
				console.log(saveHelp)
				return
			}
			await save({
				files: args,
				silent: options.silent,
				verbose: options.verbose,
			})
		},
		help: saveHelp,
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
	use: {
		name: "use",
		description: "Set template for this repository",
		run: async (args: string[], options: Record<string, any>) => {
			if (options.help) {
				console.log(useHelp)
				return
			}
			await use({
				template: args[0] || options.template,
				silent: options.silent,
				verbose: options.verbose,
			})
		},
		help: useHelp,
	},
}

function showMainHelp() {
	console.log(`
agency v${VERSION}

Usage: agency <command> [options]

Commands:
   init [path]            Initialize AGENTS.md file
   use [template]         Set template for this repository
   save <file|dir> ...    Save files/dirs to configured template
   pr [base-branch]       Create a PR branch without AGENTS.md
  source                 Switch back to source branch from PR branch
  switch                 Toggle between source and PR branch

Global Options:
  -h, --help             Show help for a command
  -v, --version          Show version number

Command Options:
  -s, --silent           Suppress output messages
  -f, --force            Force operation (pr command only)
  -v, --verbose          Show verbose output including detailed debugging info
  -t, --template         Specify template name (init command only)

Examples:
  agency init                    # Initialize in current directory
  agency init --template=work    # Initialize with specific template
  agency use                     # Interactively select template
  agency use work                # Set template to 'work'
  agency save AGENTS.md          # Save specific file to template
  agency save src/ docs/         # Save directories to template
  agency save .                  # Save current directory contents
  agency pr                      # Create PR branch (prompts for base branch)
  agency pr origin/main          # Create PR branch using origin/main as base
  agency pr --verbose            # Create PR branch with detailed output
  agency source                  # Switch from PR branch to source branch
  agency switch                  # Toggle between source and PR branch
  agency init --help             # Show help for init command
  agency --version               # Show version number

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
