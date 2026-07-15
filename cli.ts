#!/usr/bin/env bun

import { parseArgs } from "util"
import { Effect, Layer } from "effect"
import { init, help as initHelp } from "./src/commands/init"
import { task, help as taskHelp } from "./src/commands/task"
import { pr, help as prHelp } from "./src/commands/pr"
import { work, help as workHelp } from "./src/commands/work"
import { status, help as statusHelp } from "./src/commands/status"
import { validate, help as validateHelp } from "./src/commands/validate"
import type { Command } from "./src/types"
import { setColorsEnabled } from "./src/utils/colors"
import { GitService } from "./src/services/GitService"
import { ConfigService } from "./src/services/ConfigService"
import { FileSystemService } from "./src/services/FileSystemService"
import { PromptService } from "./src/services/PromptService"
import { TemplateService } from "./src/services/TemplateService"
import { OpencodeService } from "./src/services/OpencodeService"
import { ClaudeService } from "./src/services/ClaudeService"
import { FilterRepoService } from "./src/services/FilterRepoService"
import { FormatterService } from "./src/services/FormatterService"
import { WorkbaseService } from "./src/services/WorkbaseService"

// Create CLI layer with all services
const CliLayer = Layer.mergeAll(
	GitService.Default,
	ConfigService.Default,
	FileSystemService.Default,
	PromptService.Default,
	TemplateService.Default,
	OpencodeService.Default,
	ClaudeService.Default,
	FilterRepoService.Default,
	FormatterService.Default,
	WorkbaseService.Default,
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

	// Catch typed errors and convert to standard Error objects
	const programWithErrorHandling = Effect.catchAll(providedEffect, (error) => {
		// Convert typed errors to standard Error objects with clear messages
		if (error instanceof Error) {
			return Effect.fail(error)
		}
		// Handle objects with message property (common pattern for tagged errors)
		if (
			typeof error === "object" &&
			error !== null &&
			"message" in error &&
			typeof error.message === "string"
		) {
			return Effect.fail(new Error(error.message))
		}
		// Fallback: convert to string
		return Effect.fail(new Error(String(error)))
	})

	// Catch defects (unexpected crashes) and convert to errors
	const program = Effect.catchAllDefect(programWithErrorHandling, (defect) =>
		Effect.fail(defect instanceof Error ? defect : new Error(String(defect))),
	)

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
	pr: {
		name: "pr",
		description: "Run gh pr with the emitted branch name",
		run: async (
			_args: string[],
			options: Record<string, any>,
			rawArgs?: string[],
		) => {
			if (options.help) {
				console.log(prHelp)
				return
			}
			// Pass raw args (after filtering agency flags) directly to gh pr
			// This allows flags like --web to pass through without needing --
			const agencyFlags = ["--help", "-h", "--silent", "-s", "--verbose", "-v"]
			const filteredArgs = (rawArgs ?? []).filter(
				(arg) => !agencyFlags.includes(arg),
			)
			await runCommand(
				pr({
					args: filteredArgs,
					silent: options.silent,
					verbose: options.verbose,
				}),
			)
		},
		help: prHelp,
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
					squash: options.squash,
				}),
			)
		},
		help: taskHelp,
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
	validate: {
		name: "validate",
		description: "Validate the current workbase",
		run: async (_args: string[], options: Record<string, any>) => {
			if (options.help) {
				console.log(validateHelp)
				return
			}
			await runCommand(
				validate({
					silent: options.silent,
					verbose: options.verbose,
					json: options.json,
				}),
			)
		},
		help: validateHelp,
	},
}

function showMainHelp() {
	console.log(`
agency v${VERSION}

Usage: agency <command> [options]

Commands:
  init                   Initialize agency with template selection (run first)
  task [branch]          Initialize template files on a feature branch
  work                   Start working on TASK.md with OpenCode
  pr <subcommand>        Run gh pr with the emitted branch name
  status                 Show agency status for this repository
  validate               Validate the current workbase

Global Options:
  -h, --help             Show help for a command
  -v, --version          Show version number
  --no-color             Disable color output
  -s, --silent           Suppress output messages
  -v, --verbose          Show verbose output including detailed debugging info

Examples:
  agency init                         # Initialize with template (run first)
  agency task my-feature              # Create 'my-feature' branch from origin/main
  agency work                         # Start working with OpenCode

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
			squash: {
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

	// Run the command, passing raw args for commands that need them (like pr)
	await command.run(cmdPositionals, cmdValues, commandArgs)
} catch (error) {
	if (error instanceof Error) {
		let message = error.message

		// Handle Effect FiberFailure errors that wrap tagged errors
		// When the message is generic "An error has occurred", try to extract the actual error
		if (message === "An error has occurred") {
			// Try to extract the actual error from Effect's Cause structure
			const causeSymbol = Object.getOwnPropertySymbols(error).find((s) =>
				s.toString().includes("Cause"),
			)
			if (causeSymbol) {
				const cause = (error as any)[causeSymbol]
				if (cause && cause._tag === "Fail" && cause.failure) {
					const failure = cause.failure
					// Try common error message patterns
					message =
						failure.message ||
						failure.stderr ||
						(failure._tag
							? `${failure._tag}: ${JSON.stringify(failure)}`
							: JSON.stringify(failure))
				}
			}
		}

		console.error(`ⓘ ${message}`)
	} else {
		console.error("An unexpected error occurred:", error)
	}
	process.exit(1)
}
