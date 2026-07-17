#!/usr/bin/env bun

import { Effect, Either, Layer } from "effect"
import { join, resolve } from "node:path"
import { parseCli } from "./src/cli-parser"
import { init, help as initHelp } from "./src/commands/init"
import { task, help as taskHelp } from "./src/commands/task"
import { pr, help as prHelp } from "./src/commands/pr"
import { work, workPrepare, help as workHelp } from "./src/commands/work"
import { status, help as statusHelp } from "./src/commands/status"
import { validate, help as validateHelp } from "./src/commands/validate"
import { context, help as contextHelp } from "./src/commands/context"
import { graph, help as graphHelp } from "./src/commands/graph"
import { next, help as nextHelp } from "./src/commands/next"
import { sync, help as syncHelp } from "./src/commands/sync"
import { repo, help as repoHelp } from "./src/commands/repo"
import { epic, help as epicHelp } from "./src/commands/epic"
import { phase, help as phaseHelp } from "./src/commands/phase"
import { archive, help as archiveHelp } from "./src/commands/archive"
import { workbase, help as workbaseHelp } from "./src/commands/workbase"
import {
	integration,
	help as integrationHelp,
} from "./src/commands/integration"
import type { Command } from "./src/types"
import { FileSystemService } from "./src/services/FileSystemService"
import { WorkbaseService } from "./src/services/WorkbaseService"
import { RepositoryService } from "./src/services/RepositoryService"
import { EpicService } from "./src/services/EpicService"
import { TaskService } from "./src/services/TaskService"
import { PhaseService } from "./src/services/PhaseService"
import { WorktreeService } from "./src/services/WorktreeService"
import { PullRequestService } from "./src/services/PullRequestService"
import { ArchiveService } from "./src/services/ArchiveService"
import { IntegrationService } from "./src/services/IntegrationService"
import { ContextService } from "./src/services/ContextService"
import { GraphService } from "./src/services/GraphService"
import { ClaimService } from "./src/services/ClaimService"
import { SyncService } from "./src/services/SyncService"
import { ReadinessService } from "./src/services/ReadinessService"
import {
	claimCommand,
	claimHelp,
	releaseHelp,
	finishHelp,
} from "./src/commands/claim"
import {
	collectCommandResult,
	errorEnvelope,
	successEnvelope,
	writeEnvelope,
} from "./src/protocol"

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
	ArchiveService.Default,
	IntegrationService.Default,
	ContextService.Default,
	GraphService.Default,
	ClaimService.Default,
	SyncService.Default,
	ReadinessService.Default,
)

/**
 * Run a command Effect with all services provided
 */
async function runEffect<A, E>(effect: Effect.Effect<A, E, any>): Promise<A> {
	const providedEffect = Effect.provide(effect, CliLayer) as Effect.Effect<
		A,
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
	if (Either.isLeft(result)) throw result.left
	return result.right
}

const runCommand = <E>(effect: Effect.Effect<void, E, any>) => runEffect(effect)

const resolveInvocationCwd = (
	commandName: string,
	options: Record<string, any>,
) =>
	runEffect(
		Effect.gen(function* () {
			if (
				options.help ||
				commandName === "init" ||
				commandName === "workbase"
			) {
				return resolve(options.cwd ?? process.cwd())
			}
			const workbases = yield* WorkbaseService
			if (options.workbase) {
				return yield* workbases.resolveRegistered(options.workbase)
			}
			if (options.cwd) {
				const selectedCwd = resolve(options.cwd)
				yield* workbases.discover(selectedCwd)
				return selectedCwd
			}
			return yield* workbases.discover(process.cwd()).pipe(
				Effect.as(process.cwd()),
				Effect.catchTag("WorkbaseNotFoundError", () =>
					workbases
						.getDefault()
						.pipe(Effect.map((entry) => entry?.path ?? process.cwd())),
				),
			)
		}),
	)

// Read version from package.json
const packageJson = await Bun.file(
	new URL("./package.json", import.meta.url),
).json()
const VERSION = packageJson.version

// Define commands
const commands: Record<string, Command> = {
	claim: {
		run: async (args: string[], options: Record<string, any>) => {
			if (options.help) return console.log(claimHelp)
			await runCommand(
				claimCommand({
					operation: "claim",
					taskId: args[0],
					phaseId: args[1],
					claimant: options.claimant,
					runner: options.runner,
					sessionId: options["session-id"],
					revision: options.revision,
					expiresAt: options["expires-at"],
					json: options.json,
					silent: options.silent,
					verbose: options.verbose,
					cwd: options.cwd,
				}),
			)
		},
	},
	release: {
		run: async (args: string[], options: Record<string, any>) => {
			if (options.help) return console.log(releaseHelp)
			await runCommand(
				claimCommand({
					operation: "release",
					taskId: args[0],
					phaseId: args[1],
					sessionId: options["session-id"],
					revision: options.revision,
					json: options.json,
					silent: options.silent,
					verbose: options.verbose,
					cwd: options.cwd,
				}),
			)
		},
	},
	finish: {
		run: async (args: string[], options: Record<string, any>) => {
			if (options.help) return console.log(finishHelp)
			await runCommand(
				claimCommand({
					operation: "finish",
					taskId: args[0],
					phaseId: args[1],
					sessionId: options["session-id"],
					revision: options.revision,
					outcome: options.outcome,
					json: options.json,
					silent: options.silent,
					verbose: options.verbose,
					cwd: options.cwd,
				}),
			)
		},
	},
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
					cwd: options.cwd,
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
					statuses: options.status,
					repositories: options.repository,
					ready: options.ready,
					blocked: options.blocked,
					pr: options.pr ? true : options["no-pr"] ? false : undefined,
					silent: options.silent,
					verbose: options.verbose,
					cwd: options.cwd,
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
					force: options.force,
					json: options.json,
					silent: options.silent,
					verbose: options.verbose,
					cwd: options.cwd,
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
					statuses: options.status,
					repositories: options.repository,
					ready: options.ready,
					blocked: options.blocked,
					pr: options.pr ? true : options["no-pr"] ? false : undefined,
					silent: options.silent,
					verbose: options.verbose,
					cwd: options.cwd,
				}),
			)
		},
	},
	archive: {
		run: async (args: string[], options: Record<string, any>) => {
			if (options.help) {
				console.log(archiveHelp)
				return
			}
			await runCommand(
				archive({
					type: args[0],
					args: args.slice(1),
					json: options.json,
					silent: options.silent,
					verbose: options.verbose,
					cwd: options.cwd,
				}),
			)
		},
	},
	workbase: {
		run: async (args: string[], options: Record<string, any>) => {
			if (options.help) {
				console.log(workbaseHelp)
				return
			}
			await runCommand(
				workbase({
					subcommand: args[0],
					args: args.slice(1),
					json: options.json,
					name: options.name,
					clear: options.clear,
					silent: options.silent,
					verbose: options.verbose,
					cwd: options.cwd,
				}),
			)
		},
	},
	integration: {
		run: async (args: string[], options: Record<string, any>) => {
			if (options.help) {
				console.log(integrationHelp)
				return
			}
			await runCommand(
				integration({
					subcommand: args[0],
					json: options.json,
					silent: options.silent,
					verbose: options.verbose,
					cwd: options.cwd,
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
					cwd: options.cwd,
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
					statuses: options.status,
					repositories: options.repository,
					ready: options.ready,
					blocked: options.blocked,
					pr: options.pr ? true : options["no-pr"] ? false : undefined,
					silent: options.silent,
					verbose: options.verbose,
					inputAllowed: options.inputAllowed,
					cwd: options.cwd,
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
			const preparing = args[0] === "prepare"
			await runCommand(
				(preparing ? workPrepare : work)({
					directory: args[preparing ? 1 : 0],
					epicId: options.epic,
					json: options.json,
					dryRun: options["dry-run"],
					silent: options.silent,
					verbose: options.verbose,
					opencode: options.opencode,
					claude: options.claude,
					runner: options.runner,
					printCommand: options["print-command"],
					force: options.force,
					inputAllowed: options.inputAllowed,
					cwd: options.cwd,
					taskId: options.task,
					phaseId: options.phase,
				}),
			)
		},
	},
	next: {
		run: async (_args: string[], options: Record<string, any>) => {
			if (options.help) return console.log(nextHelp)
			await runCommand(
				next({
					select: options.select,
					json: options.json,
					silent: options.silent,
					verbose: options.verbose,
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
					statuses: options.status,
					repositories: options.repository,
					ready: options.ready,
					blocked: options.blocked,
					pr: options.pr ? true : options["no-pr"] ? false : undefined,
					cwd: options.cwd,
				}),
			)
		},
	},
	validate: {
		run: async (args: string[], options: Record<string, any>) => {
			if (options.help) {
				console.log(validateHelp)
				return
			}
			await runCommand(
				validate({
					path: args[0],
					silent: options.silent,
					verbose: options.verbose,
					json: options.json,
					inputAllowed: options.inputAllowed,
					cwd: options.cwd,
				}),
			)
		},
	},
	context: {
		run: async (args: string[], options: Record<string, any>) => {
			if (options.help) {
				console.log(contextHelp)
				return
			}
			await runCommand(
				context({
					target: options.epic
						? join("epics", options.epic)
						: options.phase
							? join("tasks", options.task, "phases", options.phase)
							: options.task
								? join("tasks", options.task)
								: args[0],
					compact: options.compact,
					json: options.json,
					silent: options.silent,
					verbose: options.verbose,
					cwd: options.cwd,
				}),
			)
		},
	},
	graph: {
		run: async (_args: string[], options: Record<string, any>) => {
			if (options.help) {
				console.log(graphHelp)
				return
			}
			await runCommand(
				graph({
					json: options.json,
					jsonl: options.jsonl,
					ready: options.ready,
					blocked: options.blocked,
					statuses: options.status,
					repositories: options.repository,
					kinds: options.kind,
					include: options.include,
					silent: options.silent,
					verbose: options.verbose,
					cwd: options.cwd,
				}),
			)
		},
	},
	sync: {
		run: async (_args: string[], options: Record<string, any>) => {
			if (options.help) {
				console.log(syncHelp)
				return
			}
			await runCommand(
				sync({
					apply: options.apply,
					dryRun: options["dry-run"],
					json: options.json,
					silent: options.silent,
					verbose: options.verbose,
					cwd: options.cwd,
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
  workbase <subcommand>  Manage registered workbases
  integration <command> Inspect or sync managed integration files
  epic <subcommand>      Manage epics
  phase <subcommand>     Manage task phases
  claim <task> [phase]   Claim an execution unit
  release <task> [phase] Release an execution unit
  finish <task> [phase]  Finish an execution unit
  archive <type>         Archive a work item
  task <subcommand>      Manage tasks
  work [directory|task]  Work on an epic, task, or phase
  next                   List or select ready execution units
  pr create              Create a pull request for an execution unit
  repo <subcommand>      Manage workbase repositories
  status                 Show status for the current workbase
  validate [path]        Validate a workbase
  context [target]       Return complete target context
  graph                  Export the complete workbase graph
  sync                   Reconcile declarations with external state

Global Options:
  -h, --help             Show help for a command
  -V, --version          Show version number
  -s, --silent           Suppress output messages
  -v, --verbose          Show verbose output including detailed debugging info
  --no-input             Never open an interactive prompt or selector
  --workbase <selector>  Use a registered workbase ID, name, or path
  --cwd <path>           Resolve context from this directory

Examples:
  agency init                         # Initialize the current directory
  agency task list                    # List tasks
  agency work tasks/refresh-cli-copy  # Start working on a task

For more information about a command, run:
  agency <command> --help
	`)
}

const machineMode = process.argv
	.slice(2)
	.some((argument) => argument === "--json" || argument === "--jsonl")

try {
	const args = process.argv.slice(2)
	const { commandName, args: commandArgs, values } = parseCli(args)

	// Handle global flags
	if (values.version) {
		if (machineMode) {
			writeEnvelope(successEnvelope({ version: VERSION }))
		} else {
			console.log(`v${VERSION}`)
		}
		process.exit(0)
	}

	// Get command
	// Show help if no command
	if (!commandName) {
		showMainHelp()
		process.exit(values.help ? 0 : 1)
	}

	const command = commands[commandName]!
	const inputAllowed =
		!values.json &&
		!values["no-input"] &&
		Boolean(process.stdin.isTTY && process.stderr.isTTY)
	const cwd = await resolveInvocationCwd(commandName, values)
	if (values.json || (values.jsonl && values.help)) {
		const result = await collectCommandResult(() =>
			command.run(commandArgs, { ...values, cwd, inputAllowed }),
		)
		writeEnvelope(successEnvelope(result))
	} else if (values.jsonl) {
		await command.run(commandArgs, { ...values, cwd, inputAllowed: false })
	} else {
		await command.run(commandArgs, { ...values, cwd, inputAllowed })
	}
} catch (error) {
	if (machineMode) {
		writeEnvelope(errorEnvelope(error))
		process.exit(1)
	}
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
