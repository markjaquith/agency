import { parseArgs, type ParseArgsConfig } from "node:util"

type OptionConfig = NonNullable<ParseArgsConfig["options"]>

interface LeafCommand {
	readonly usage: string
	readonly minArgs: number
	readonly maxArgs: number
	readonly options?: readonly string[]
	readonly required?: readonly string[]
	readonly repeatable?: readonly string[]
	readonly conflicts?: readonly (readonly [string, string])[]
}

interface CommandDefinition {
	readonly usage: string
	readonly options: OptionConfig
	readonly command?: LeafCommand
	readonly subcommands?: Readonly<Record<string, LeafCommand>>
}

const commonOptions = {
	help: { type: "boolean", short: "h" },
	version: { type: "boolean", short: "V" },
	silent: { type: "boolean", short: "s" },
	verbose: { type: "boolean", short: "v" },
	"no-input": { type: "boolean" },
} satisfies OptionConfig

const outputOptions = {
	...commonOptions,
	json: { type: "boolean" },
} satisfies OptionConfig

const createOptions = {
	...outputOptions,
	"ticket-url": { type: "string" },
	description: { type: "string" },
	repo: { type: "string", multiple: true },
} satisfies OptionConfig

const taskCreateOptions = {
	...createOptions,
	reference: { type: "string", multiple: true },
	epic: { type: "string" },
	branch: { type: "string" },
	base: { type: "string" },
	"multi-phase": { type: "boolean" },
} satisfies OptionConfig

const phaseCreateOptions = {
	...outputOptions,
	description: { type: "string" },
	repo: { type: "string", multiple: true },
	reference: { type: "string", multiple: true },
	branch: { type: "string" },
	base: { type: "string" },
	"depends-on": { type: "string", multiple: true },
	"first-phase": { type: "string" },
} satisfies OptionConfig

const commands = {
	init: {
		usage: "agency init [path] [--json]",
		options: outputOptions,
		command: {
			usage: "agency init [path] [--json]",
			minArgs: 0,
			maxArgs: 1,
			options: ["json"],
		},
	},
	workbase: {
		usage: "agency workbase <add|list>",
		options: outputOptions,
		subcommands: {
			add: {
				usage: "agency workbase add <path> [--json]",
				minArgs: 1,
				maxArgs: 1,
				options: ["json"],
			},
			list: {
				usage: "agency workbase list [--json]",
				minArgs: 0,
				maxArgs: 0,
				options: ["json"],
			},
		},
	},
	repo: {
		usage: "agency repo <add|link|list>",
		options: outputOptions,
		subcommands: {
			add: {
				usage: "agency repo add <alias> <remote> [--json]",
				minArgs: 2,
				maxArgs: 2,
				options: ["json"],
			},
			link: {
				usage: "agency repo link <alias> <path> [--json]",
				minArgs: 2,
				maxArgs: 2,
				options: ["json"],
			},
			list: {
				usage: "agency repo list [--json]",
				minArgs: 0,
				maxArgs: 0,
				options: ["json"],
			},
		},
	},
	epic: {
		usage: "agency epic <create|list|show>",
		options: createOptions,
		subcommands: {
			create: {
				usage:
					"agency epic create <id> --ticket-url <url> --repo <alias>:<ref> [--repo <alias>:<ref>...]",
				minArgs: 1,
				maxArgs: 1,
				options: ["ticket-url", "description", "repo", "json"],
				required: ["ticket-url", "repo"],
				repeatable: ["repo"],
			},
			list: {
				usage: "agency epic list [--json]",
				minArgs: 0,
				maxArgs: 0,
				options: ["json"],
			},
			show: {
				usage: "agency epic show <id> [--json]",
				minArgs: 1,
				maxArgs: 1,
				options: ["json"],
			},
		},
	},
	task: {
		usage: "agency task <new|create|list|show|status>",
		options: taskCreateOptions,
		subcommands: {
			new: {
				usage: "agency task new [id] [options]",
				minArgs: 0,
				maxArgs: 1,
				options: [
					"ticket-url",
					"description",
					"epic",
					"repo",
					"reference",
					"branch",
					"base",
					"multi-phase",
					"json",
				],
				repeatable: ["reference"],
			},
			create: {
				usage:
					"agency task create <id> (--repo <alias> | --multi-phase) [options]",
				minArgs: 1,
				maxArgs: 1,
				options: [
					"ticket-url",
					"description",
					"epic",
					"repo",
					"reference",
					"branch",
					"base",
					"multi-phase",
					"json",
				],
				repeatable: ["reference"],
			},
			list: {
				usage: "agency task list [--json]",
				minArgs: 0,
				maxArgs: 0,
				options: ["json"],
			},
			show: {
				usage: "agency task show <id> [--json]",
				minArgs: 1,
				maxArgs: 1,
				options: ["json"],
			},
			status: {
				usage: "agency task status <id> <status> [--json]",
				minArgs: 2,
				maxArgs: 2,
				options: ["json"],
			},
		},
	},
	phase: {
		usage: "agency phase <create|list|show|status>",
		options: phaseCreateOptions,
		subcommands: {
			create: {
				usage:
					"agency phase create <task-id> <phase-id> --repo <alias> --branch <name> --base <name> [options]",
				minArgs: 2,
				maxArgs: 2,
				options: [
					"description",
					"repo",
					"reference",
					"branch",
					"base",
					"depends-on",
					"first-phase",
					"json",
				],
				required: ["repo", "branch", "base"],
				repeatable: ["reference", "depends-on"],
			},
			list: {
				usage: "agency phase list <task-id> [--json]",
				minArgs: 1,
				maxArgs: 1,
				options: ["json"],
			},
			show: {
				usage: "agency phase show <task-id> <phase-id> [--json]",
				minArgs: 2,
				maxArgs: 2,
				options: ["json"],
			},
			status: {
				usage: "agency phase status <task-id> <phase-id> <status> [--json]",
				minArgs: 3,
				maxArgs: 3,
				options: ["json"],
			},
		},
	},
	archive: {
		usage: "agency archive <epic|task|phase>",
		options: outputOptions,
		subcommands: {
			epic: {
				usage: "agency archive epic <epic-id> [--json]",
				minArgs: 1,
				maxArgs: 1,
				options: ["json"],
			},
			task: {
				usage: "agency archive task <task-id> [--json]",
				minArgs: 1,
				maxArgs: 1,
				options: ["json"],
			},
			phase: {
				usage: "agency archive phase <task-id> <phase-id> [--json]",
				minArgs: 2,
				maxArgs: 2,
				options: ["json"],
			},
		},
	},
	work: {
		usage: "agency work [<directory-or-task-id> | --epic <epic-id>]",
		options: {
			...commonOptions,
			epic: { type: "string" },
			opencode: { type: "boolean" },
			claude: { type: "boolean" },
		},
		command: {
			usage: "agency work [<directory-or-task-id> | --epic <epic-id>]",
			minArgs: 0,
			maxArgs: 1,
			options: ["epic", "opencode", "claude"],
			conflicts: [
				["opencode", "claude"],
				["epic", "$positional"],
			],
		},
	},
	pr: {
		usage: "agency pr create <task-id> [phase-id]",
		options: {
			...outputOptions,
			draft: { type: "boolean" },
		},
		subcommands: {
			create: {
				usage: "agency pr create <task-id> [phase-id] [--draft] [--json]",
				minArgs: 1,
				maxArgs: 2,
				options: ["draft", "json"],
			},
		},
	},
	status: {
		usage: "agency status [--json]",
		options: outputOptions,
		command: {
			usage: "agency status [--json]",
			minArgs: 0,
			maxArgs: 0,
			options: ["json"],
		},
	},
	validate: {
		usage: "agency validate [path] [--json] [--no-input]",
		options: {
			...outputOptions,
		},
		command: {
			usage: "agency validate [path] [--json] [--no-input]",
			minArgs: 0,
			maxArgs: 1,
			options: ["json"],
		},
	},
} satisfies Readonly<Record<string, CommandDefinition>>

const rootOptions = commonOptions
const commonOptionNames = new Set(Object.keys(commonOptions))
const preCommandOptions = new Set([
	"--help",
	"-h",
	"--version",
	"-V",
	"--silent",
	"-s",
	"--verbose",
	"-v",
	"--no-input",
])

export interface ParsedCli {
	readonly commandName?: keyof typeof commands
	readonly args: string[]
	readonly values: Record<
		string,
		boolean | string | (boolean | string)[] | undefined
	>
}

const usageError = (message: string, usage: string) =>
	new Error(`${message}\n\nUsage: ${usage}`)

const optionLabel = (name: string) => `--${name}`

function findCommandIndex(args: readonly string[]) {
	for (const [index, argument] of args.entries()) {
		if (!argument.startsWith("-")) return index
		if (!preCommandOptions.has(argument) && !/^-[hVsv]+$/.test(argument)) {
			throw usageError(
				`Unknown option '${argument}'.`,
				"agency <command> [options]",
			)
		}
	}
	return -1
}

function assertNoDuplicateOptions(
	tokens: readonly { readonly kind: string; readonly name?: string }[],
	repeatable: ReadonlySet<string>,
	usage: string,
) {
	const counts = new Map<string, number>()
	for (const token of tokens) {
		if (token.kind !== "option" || !token.name) continue
		const count = (counts.get(token.name) ?? 0) + 1
		counts.set(token.name, count)
		if (count > 1 && !repeatable.has(token.name)) {
			throw usageError(
				`Option '${optionLabel(token.name)}' may only be specified once.`,
				usage,
			)
		}
	}
}

function parse(args: readonly string[], options: OptionConfig, usage: string) {
	try {
		return parseArgs({
			args: [...args],
			options,
			strict: true,
			allowPositionals: true,
			tokens: true,
		})
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		throw usageError(message, usage)
	}
}

function validateTaskCreate(
	values: ParsedCli["values"],
	spec: LeafCommand,
	requireRepo: boolean,
) {
	if (values["multi-phase"]) {
		for (const option of ["repo", "reference", "branch", "base"] as const) {
			if (values[option] !== undefined) {
				throw usageError(
					`Option '--multi-phase' cannot be combined with '${optionLabel(option)}'.`,
					spec.usage,
				)
			}
		}
	} else if (requireRepo && values.repo === undefined) {
		throw usageError(
			"Option '--repo' is required unless '--multi-phase' is used.",
			spec.usage,
		)
	}
}

export function parseCli(args: readonly string[]): ParsedCli {
	const commandIndex = findCommandIndex(args)
	if (commandIndex === -1) {
		const parsed = parse(args, rootOptions, "agency <command> [options]")
		assertNoDuplicateOptions(
			parsed.tokens,
			new Set(),
			"agency <command> [options]",
		)
		if (parsed.values.silent && parsed.values.verbose) {
			throw usageError(
				"Options '--silent' and '--verbose' cannot be combined.",
				"agency <command> [options]",
			)
		}
		return { args: [], values: parsed.values }
	}

	const commandName = args[commandIndex]!
	const definition: CommandDefinition | undefined =
		commands[commandName as keyof typeof commands]
	if (!definition) {
		throw usageError(
			`Unknown command '${commandName}'.`,
			"agency <command> [options]",
		)
	}
	const commandArgs = [
		...args.slice(0, commandIndex),
		...args.slice(commandIndex + 1),
	]
	const parsed = parse(commandArgs, definition.options, definition.usage)
	const subcommand = definition.subcommands ? parsed.positionals[0] : undefined
	if (definition.subcommands && !subcommand && parsed.values.help) {
		for (const token of parsed.tokens) {
			if (token.kind === "option" && !commonOptionNames.has(token.name)) {
				throw usageError(
					`Option '${optionLabel(token.name)}' is not valid for this command.`,
					definition.usage,
				)
			}
		}
		assertNoDuplicateOptions(parsed.tokens, new Set(), definition.usage)
		return {
			commandName: commandName as keyof typeof commands,
			args: parsed.positionals,
			values: parsed.values,
		}
	}
	const spec = definition.subcommands
		? definition.subcommands[subcommand ?? ""]
		: definition.command
	if (!spec) {
		const message = subcommand
			? `Unknown subcommand '${subcommand}' for 'agency ${commandName}'.`
			: `A subcommand is required for 'agency ${commandName}'.`
		throw usageError(message, definition.usage)
	}

	const commandPositionals = definition.subcommands
		? parsed.positionals.slice(1)
		: parsed.positionals
	const allowed = new Set([...commonOptionNames, ...(spec.options ?? [])])
	for (const token of parsed.tokens) {
		if (token.kind === "option" && !allowed.has(token.name)) {
			throw usageError(
				`Option '${optionLabel(token.name)}' is not valid for this command.`,
				spec.usage,
			)
		}
	}
	assertNoDuplicateOptions(parsed.tokens, new Set(spec.repeatable), spec.usage)

	if (parsed.values.silent && parsed.values.verbose) {
		throw usageError(
			"Options '--silent' and '--verbose' cannot be combined.",
			spec.usage,
		)
	}
	if (parsed.values.version) {
		return {
			commandName: commandName as keyof typeof commands,
			args: parsed.positionals,
			values: parsed.values,
		}
	}
	if (parsed.values.help) {
		return {
			commandName: commandName as keyof typeof commands,
			args: parsed.positionals,
			values: parsed.values,
		}
	}

	if (
		commandPositionals.length < spec.minArgs ||
		commandPositionals.length > spec.maxArgs
	) {
		throw usageError(
			`Expected ${spec.minArgs === spec.maxArgs ? spec.minArgs : `${spec.minArgs}-${spec.maxArgs}`} positional argument${spec.maxArgs === 1 ? "" : "s"}, received ${commandPositionals.length}.`,
			spec.usage,
		)
	}
	for (const name of spec.required ?? []) {
		if (parsed.values[name] === undefined) {
			throw usageError(`Option '${optionLabel(name)}' is required.`, spec.usage)
		}
	}
	for (const [left, right] of spec.conflicts ?? []) {
		const leftSet = parsed.values[left] !== undefined
		const rightSet =
			right === "$positional"
				? commandPositionals.length > 0
				: parsed.values[right] !== undefined
		if (leftSet && rightSet) {
			throw usageError(
				`Option '${optionLabel(left)}' cannot be combined with ${right === "$positional" ? "a positional argument" : `'${optionLabel(right)}'`}.`,
				spec.usage,
			)
		}
	}
	if (
		commandName === "task" &&
		(subcommand === "new" || subcommand === "create")
	) {
		validateTaskCreate(parsed.values, spec, subcommand === "create")
	}

	return {
		commandName: commandName as keyof typeof commands,
		args: parsed.positionals,
		values: parsed.values,
	}
}
