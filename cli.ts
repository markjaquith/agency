#!/usr/bin/env bun

import { parseArgs } from "util"
import { Effect, Either, Layer } from "effect"
import { init, help as initHelp } from "./src/commands/init"
import { task, help as taskHelp } from "./src/commands/task"
import { pr, help as prHelp } from "./src/commands/pr"
import { work, help as workHelp } from "./src/commands/work"
import { status, help as statusHelp } from "./src/commands/status"
import { validate, help as validateHelp } from "./src/commands/validate"
import { repo, help as repoHelp } from "./src/commands/repo"
import { epic, help as epicHelp } from "./src/commands/epic"
import { phase, help as phaseHelp } from "./src/commands/phase"
import type { Command } from "./src/types"
import { FileSystemService } from "./src/services/FileSystemService"
import { WorkbaseService } from "./src/services/WorkbaseService"
import { RepositoryService } from "./src/services/RepositoryService"
import { EpicService } from "./src/services/EpicService"
import { TaskService } from "./src/services/TaskService"
import { PhaseService } from "./src/services/PhaseService"
import { WorktreeService } from "./src/services/WorktreeService"
import { PullRequestService } from "./src/services/PullRequestService"

// Create CLI layer with all services
const CliLayer = Layer.mergeAll(
	FileSystemService.Default,
	WorkbaseService.Default,
	RepositoryService.Default,
	EpicService.Default,
	TaskService.Default,
	PhaseService.Default,
	WorktreeService.Default,
	PullRequestService.Default,
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

	const toError = (error: unknown) => {
		if (error instanceof Error) {
			return error
		}
		if (
			typeof error === "object" &&
			error !== null &&
			"message" in error &&
			typeof error.message === "string"
		) {
			return new Error(error.message)
		}
		return new Error(String(error))
	}

	const result = await Effect.runPromise(
		providedEffect.pipe(
			Effect.catchAllDefect((defect) => Effect.fail(toError(defect))),
			Effect.either,
		),
	)
	if (Either.isLeft(result)) throw toError(result.left)
}

// Read version from package.json
const packageJson = await Bun.file(
	new URL("./package.json", import.meta.url),
).json()
const VERSION = packageJson.version

// Define commands
const commands: Record<string, Command> = {
	init: {
		run: async (args: string[], options: Record<string, any>) => {
			if (options.help) {
				console.log(initHelp)
				return
			}
			await runCommand(
				init({
					path: args[0],
					json: options.json,
					silent: options.silent,
					verbose: options.verbose,
				}),
			)
		},
	},
	epic: {
		run: async (args: string[], options: Record<string, any>) => {
			if (options.help) {
				console.log(epicHelp)
				return
			}
			await runCommand(
				epic({
					subcommand: args[0],
					args: args.slice(1),
					ticketUrl: options["ticket-url"],
					description: options.description,
					repos: options.repo,
					json: options.json,
					silent: options.silent,
					verbose: options.verbose,
				}),
			)
		},
	},
	pr: {
		run: async (args: string[], options: Record<string, any>) => {
			if (options.help) {
				console.log(prHelp)
				return
			}
			await runCommand(
				pr({
					subcommand: args[0],
					taskId: args[1],
					phaseId: args[2],
					draft: options.draft,
					json: options.json,
					silent: options.silent,
					verbose: options.verbose,
				}),
			)
		},
	},
	phase: {
		run: async (args: string[], options: Record<string, any>) => {
			if (options.help) return console.log(phaseHelp)
			await runCommand(
				phase({
					subcommand: args[0],
					args: args.slice(1),
					description: options.description,
					repo: options.repo?.[0],
					references: options.reference,
					branch: options.branch,
					base: options.base,
					dependsOn: options["depends-on"],
					firstPhase: options["first-phase"],
					json: options.json,
					silent: options.silent,
					verbose: options.verbose,
				}),
			)
		},
	},
	repo: {
		run: async (args: string[], options: Record<string, any>) => {
			if (options.help) {
				console.log(repoHelp)
				return
			}
			await runCommand(
				repo({
					subcommand: args[0],
					args: args.slice(1),
					silent: options.silent,
					verbose: options.verbose,
					json: options.json,
				}),
			)
		},
	},
	task: {
		run: async (args: string[], options: Record<string, any>) => {
			if (options.help) {
				console.log(taskHelp)
				return
			}
			await runCommand(
				task({
					subcommand: args[0],
					args: args.slice(1),
					ticketUrl: options["ticket-url"],
					description: options.description,
					epic: options.epic,
					repo: options.repo?.[0],
					references: options.reference,
					branch: options.branch,
					base: options.base,
					multiPhase: options["multi-phase"],
					json: options.json,
					silent: options.silent,
					verbose: options.verbose,
				}),
			)
		},
	},
	work: {
		run: async (args: string[], options: Record<string, any>) => {
			if (options.help) {
				console.log(workHelp)
				return
			}

			await runCommand(
				work({
					taskId: args[0],
					phaseId: args[1],
					silent: options.silent,
					verbose: options.verbose,
					opencode: options.opencode,
					claude: options.claude,
				}),
			)
		},
	},
	status: {
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
	},
	validate: {
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
	},
}

function showMainHelp() {
	console.log(`
agency v${VERSION}

Usage: agency <command> [options]

Commands:
  init [path]            Initialize an Agency workbase
  epic <subcommand>      Manage epics
  phase <subcommand>     Manage task phases
  task <subcommand>      Manage tasks
  work <task> [phase]    Materialize worktrees and launch an agent
  pr create              Create a pull request for an execution unit
  repo <subcommand>      Manage workbase repositories
  status                 Show status for the current workbase
  validate               Validate the current workbase

Global Options:
  -h, --help             Show help for a command
  -V, --version          Show version number
  -s, --silent           Suppress output messages
  -v, --verbose          Show verbose output including detailed debugging info

Examples:
  agency init                         # Initialize the current directory
  agency task list                    # List tasks
  agency work refresh-cli-copy        # Start working on a task

For more information about a command, run:
  agency <command> --help
	`)
}

try {
	const args = process.argv.slice(2)
	const { values, positionals } = parseArgs({
		args,
		options: {
			help: {
				type: "boolean",
				short: "h",
			},
			version: {
				type: "boolean",
				short: "V",
			},
			silent: {
				type: "boolean",
				short: "s",
			},
			verbose: {
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
		process.exit(values.help ? 0 : 1)
	}

	// Check if command exists
	const command = commands[commandName]
	if (!command) {
		console.error(`Error: Unknown command '${commandName}'`)
		console.error("\nRun 'agency --help' for usage information.")
		process.exit(1)
	}

	const commandIndex = args.indexOf(commandName)
	const commandArgs = [
		...args.slice(0, commandIndex),
		...args.slice(commandIndex + 1),
	]
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
			branch: {
				type: "string",
			},
			json: {
				type: "boolean",
			},
			"ticket-url": {
				type: "string",
			},
			description: {
				type: "string",
			},
			repo: {
				type: "string",
				multiple: true,
			},
			reference: {
				type: "string",
				multiple: true,
			},
			epic: { type: "string" },
			base: { type: "string" },
			"multi-phase": { type: "boolean" },
			"depends-on": { type: "string", multiple: true },
			"first-phase": { type: "string" },
			draft: { type: "boolean" },
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

	await command.run(cmdPositionals, cmdValues)
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
