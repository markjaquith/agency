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
	workbase: { type: "string" },
	cwd: { type: "string" },
} satisfies OptionConfig

const entitySelectorOptions = {
	epic: { type: "string" },
	task: { type: "string" },
	phase: { type: "string" },
} satisfies OptionConfig

const outputOptions = {
	...commonOptions,
	json: { type: "boolean" },
} satisfies OptionConfig

const viewOptions = {
	status: { type: "string", multiple: true },
	repository: { type: "string", multiple: true },
	ready: { type: "boolean" },
	blocked: { type: "boolean" },
	pr: { type: "boolean" },
	"no-pr": { type: "boolean" },
} satisfies OptionConfig

const viewOptionNames = [
	"status",
	"repository",
	"ready",
	"blocked",
	"pr",
	"no-pr",
] as const

const viewConflicts = [
	["ready", "blocked"],
	["pr", "no-pr"],
] as const

const createOptions = {
	...outputOptions,
	"ticket-url": { type: "string" },
	description: { type: "string" },
	repo: { type: "string", multiple: true },
} satisfies OptionConfig

const newWorkOptions = {
	work: { type: "boolean" },
	auto: { type: "boolean" },
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

const mutationOptions = {
	"if-revision": { type: "string" },
	"clear-description": { type: "boolean" },
	"clear-ticket": { type: "boolean" },
	"clear-references": { type: "boolean" },
	"pr-url": { type: "string" },
	"clear-pr": { type: "boolean" },
	"no-epic": { type: "boolean" },
} satisfies OptionConfig

const claimOptions = {
	...outputOptions,
	claimant: { type: "string" },
	runner: { type: "string" },
	"session-id": { type: "string" },
	revision: { type: "string" },
	"expires-at": { type: "string" },
} satisfies OptionConfig

const ownedClaimOptions = {
	...outputOptions,
	"session-id": { type: "string" },
	revision: { type: "string" },
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
		usage: "agency workbase <init|add|list|show|name|remove|prune|default>",
		options: {
			...outputOptions,
			name: { type: "string" },
			clear: { type: "boolean" },
		},
		subcommands: {
			init: {
				usage: "agency workbase init [path] [--json]",
				minArgs: 0,
				maxArgs: 1,
				options: ["json"],
			},
			add: {
				usage: "agency workbase add <path> [--json]",
				minArgs: 1,
				maxArgs: 1,
				options: ["json", "name"],
			},
			list: {
				usage: "agency workbase list [--json]",
				minArgs: 0,
				maxArgs: 0,
				options: ["json"],
			},
			show: {
				usage: "agency workbase show <selector> [--json]",
				minArgs: 1,
				maxArgs: 1,
				options: ["json"],
			},
			name: {
				usage: "agency workbase name <selector> <name> | --clear [--json]",
				minArgs: 1,
				maxArgs: 2,
				options: ["json", "clear"],
			},
			remove: {
				usage: "agency workbase remove <selector> [--json]",
				minArgs: 1,
				maxArgs: 1,
				options: ["json"],
			},
			prune: {
				usage: "agency workbase prune [--json]",
				minArgs: 0,
				maxArgs: 0,
				options: ["json"],
			},
			default: {
				usage: "agency workbase default [selector | --clear] [--json]",
				minArgs: 0,
				maxArgs: 1,
				options: ["json", "clear"],
				conflicts: [["clear", "$positional"]],
			},
		},
	},
	integration: {
		usage: "agency integration <status|sync>",
		options: outputOptions,
		subcommands: {
			status: {
				usage: "agency integration status [--json]",
				minArgs: 0,
				maxArgs: 0,
				options: ["json"],
			},
			sync: {
				usage: "agency integration sync [--json]",
				minArgs: 0,
				maxArgs: 0,
				options: ["json"],
			},
		},
	},
	repo: {
		usage:
			"agency repo <setup|add|link|list|show|fetch|remove|unlink|rename|remote|verify>",
		options: {
			...outputOptions,
			"dry-run": { type: "boolean" },
			apply: { type: "boolean" },
		},
		subcommands: {
			setup: {
				usage: "agency repo setup [--dry-run | --apply] [--json]",
				minArgs: 0,
				maxArgs: 0,
				options: ["dry-run", "apply", "json"],
				conflicts: [["dry-run", "apply"]],
			},
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
			show: {
				usage: "agency repo show <alias> [--json]",
				minArgs: 1,
				maxArgs: 1,
				options: ["json"],
			},
			fetch: {
				usage: "agency repo fetch <alias> [--json]",
				minArgs: 1,
				maxArgs: 1,
				options: ["json"],
			},
			remove: {
				usage: "agency repo remove <alias> [--json]",
				minArgs: 1,
				maxArgs: 1,
				options: ["json"],
			},
			unlink: {
				usage: "agency repo unlink <alias> [--json]",
				minArgs: 1,
				maxArgs: 1,
				options: ["json"],
			},
			rename: {
				usage: "agency repo rename <alias> <new-alias> [--json]",
				minArgs: 2,
				maxArgs: 2,
				options: ["json"],
			},
			remote: {
				usage: "agency repo remote <alias> [remote] [--json]",
				minArgs: 1,
				maxArgs: 2,
				options: ["json"],
			},
			verify: {
				usage: "agency repo verify <alias> [--json]",
				minArgs: 1,
				maxArgs: 1,
				options: ["json"],
			},
		},
	},
	epic: {
		usage: "agency epic <new|create|list|show|update|rename>",
		options: {
			...createOptions,
			...newWorkOptions,
			...viewOptions,
			...mutationOptions,
			epic: { type: "string" },
		},
		subcommands: {
			new: {
				usage:
					"agency epic new <id> --ticket-url <url> --repo <alias>:<ref> [--repo <alias>:<ref>...] [--work [--auto]]",
				minArgs: 1,
				maxArgs: 1,
				options: ["ticket-url", "description", "repo", "work", "auto", "json"],
				required: ["ticket-url", "repo"],
				repeatable: ["repo"],
				conflicts: [["work", "json"]],
			},
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
				usage: "agency epic list [filters] [--json]",
				minArgs: 0,
				maxArgs: 0,
				options: ["json", ...viewOptionNames],
				repeatable: ["status", "repository"],
				conflicts: viewConflicts,
			},
			show: {
				usage: "agency epic show <id> [--json]",
				minArgs: 1,
				maxArgs: 1,
				options: ["json", "epic"],
			},
			update: {
				usage: "agency epic update <id> [options] [--json]",
				minArgs: 1,
				maxArgs: 1,
				options: [
					"description",
					"clear-description",
					"ticket-url",
					"repo",
					"if-revision",
					"json",
				],
				repeatable: ["repo"],
				conflicts: [["description", "clear-description"]],
			},
			rename: {
				usage: "agency epic rename <id> <new-id> [--json]",
				minArgs: 2,
				maxArgs: 2,
				options: ["if-revision", "json"],
			},
		},
	},
	task: {
		usage:
			"agency task <new|create|list|show|status|update|rename|move|dependency>",
		options: {
			...taskCreateOptions,
			...newWorkOptions,
			...viewOptions,
			...mutationOptions,
			"pr-url": { type: "string" },
			task: { type: "string" },
		},
		subcommands: {
			new: {
				usage: "agency task new [id] [options] [--work [--auto]]",
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
					"work",
					"auto",
					"json",
				],
				repeatable: ["reference"],
				conflicts: [["work", "json"]],
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
				usage: "agency task list [filters] [--json]",
				minArgs: 0,
				maxArgs: 0,
				options: ["json", ...viewOptionNames],
				repeatable: ["status", "repository"],
				conflicts: viewConflicts,
			},
			show: {
				usage: "agency task show <id> [--json]",
				minArgs: 1,
				maxArgs: 1,
				options: ["json", "task"],
			},
			status: {
				usage: "agency task status <id> <status> [--json]",
				minArgs: 2,
				maxArgs: 2,
				options: ["json", "task"],
			},
			update: {
				usage: "agency task update <id> [options] [--json]",
				minArgs: 1,
				maxArgs: 1,
				options: [
					"ticket-url",
					"clear-ticket",
					"description",
					"clear-description",
					"repo",
					"reference",
					"clear-references",
					"branch",
					"base",
					"pr-url",
					"clear-pr",
					"if-revision",
					"json",
				],
				repeatable: ["reference"],
				conflicts: [
					["ticket-url", "clear-ticket"],
					["description", "clear-description"],
					["reference", "clear-references"],
					["pr-url", "clear-pr"],
				],
			},
			rename: {
				usage: "agency task rename <id> <new-id> [--json]",
				minArgs: 2,
				maxArgs: 2,
				options: ["if-revision", "json"],
			},
			move: {
				usage: "agency task move <id> (--epic <id> | --no-epic) [--json]",
				minArgs: 1,
				maxArgs: 1,
				options: ["epic", "no-epic", "if-revision", "json"],
				conflicts: [["epic", "no-epic"]],
			},
			dependency: {
				usage:
					"agency task dependency <add|remove> <task-id> <dependency-id> [--json]",
				minArgs: 3,
				maxArgs: 3,
				options: ["if-revision", "json"],
			},
		},
	},
	phase: {
		usage:
			"agency phase <new|create|list|show|status|update|rename|dependency>",
		options: {
			...phaseCreateOptions,
			...newWorkOptions,
			...viewOptions,
			...mutationOptions,
			"pr-url": { type: "string" },
			task: { type: "string" },
			phase: { type: "string" },
		},
		subcommands: {
			new: {
				usage:
					"agency phase new <task-id> <phase-id> --repo <alias> --branch <name> --base <name> [options] [--work [--auto]]",
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
					"work",
					"auto",
					"json",
					"task",
					"phase",
				],
				required: ["repo", "branch", "base"],
				repeatable: ["reference", "depends-on"],
				conflicts: [["work", "json"]],
			},
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
					"task",
					"phase",
				],
				required: ["repo", "branch", "base"],
				repeatable: ["reference", "depends-on"],
			},
			list: {
				usage: "agency phase list <task-id> [filters] [--json]",
				minArgs: 1,
				maxArgs: 1,
				options: ["json", "task", ...viewOptionNames],
				repeatable: ["status", "repository"],
				conflicts: viewConflicts,
			},
			show: {
				usage: "agency phase show <task-id> <phase-id> [--json]",
				minArgs: 2,
				maxArgs: 2,
				options: ["json", "task", "phase"],
			},
			status: {
				usage: "agency phase status <task-id> <phase-id> <status> [--json]",
				minArgs: 3,
				maxArgs: 3,
				options: ["json", "task", "phase"],
			},
			update: {
				usage: "agency phase update <task-id> <phase-id> [options] [--json]",
				minArgs: 2,
				maxArgs: 2,
				options: [
					"description",
					"clear-description",
					"repo",
					"reference",
					"clear-references",
					"branch",
					"base",
					"pr-url",
					"clear-pr",
					"if-revision",
					"json",
				],
				repeatable: ["reference"],
				conflicts: [
					["description", "clear-description"],
					["reference", "clear-references"],
					["pr-url", "clear-pr"],
				],
			},
			rename: {
				usage: "agency phase rename <task-id> <phase-id> <new-id> [--json]",
				minArgs: 3,
				maxArgs: 3,
				options: ["if-revision", "json"],
			},
			dependency: {
				usage:
					"agency phase dependency <add|remove> <task-id> <phase-id> <dependency-id> [--json]",
				minArgs: 4,
				maxArgs: 4,
				options: ["if-revision", "json"],
			},
		},
	},
	claim: {
		usage: "agency claim <task-id> [phase-id] [options]",
		options: {
			...claimOptions,
			task: { type: "string" },
			phase: { type: "string" },
		},
		command: {
			usage:
				"agency claim <task-id> [phase-id] --claimant <id> --runner <id> --session-id <id> --revision <sha256> [--expires-at <timestamp>] [--json]",
			minArgs: 1,
			maxArgs: 2,
			options: [
				"claimant",
				"runner",
				"session-id",
				"revision",
				"expires-at",
				"json",
				"task",
				"phase",
			],
			required: ["claimant", "runner", "session-id", "revision"],
		},
	},
	release: {
		usage: "agency release <task-id> [phase-id] [options]",
		options: {
			...ownedClaimOptions,
			task: { type: "string" },
			phase: { type: "string" },
		},
		command: {
			usage:
				"agency release <task-id> [phase-id] --session-id <id> --revision <sha256> [--json]",
			minArgs: 1,
			maxArgs: 2,
			options: ["session-id", "revision", "json", "task", "phase"],
			required: ["session-id", "revision"],
		},
	},
	finish: {
		usage: "agency finish <task-id> [phase-id] [options]",
		options: {
			...ownedClaimOptions,
			outcome: { type: "string" },
			task: { type: "string" },
			phase: { type: "string" },
		},
		command: {
			usage:
				"agency finish <task-id> [phase-id] --session-id <id> --revision <sha256> --outcome <done|dropped> [--json]",
			minArgs: 1,
			maxArgs: 2,
			options: ["session-id", "revision", "outcome", "json", "task", "phase"],
			required: ["session-id", "revision", "outcome"],
		},
	},
	sync: {
		usage: "agency sync [--dry-run | --apply] [--json]",
		options: {
			...outputOptions,
			"dry-run": { type: "boolean" },
			apply: { type: "boolean" },
		},
		command: {
			usage: "agency sync [--dry-run | --apply] [--json]",
			minArgs: 0,
			maxArgs: 0,
			options: ["dry-run", "apply", "json"],
			conflicts: [["dry-run", "apply"]],
		},
	},
	archive: {
		usage: "agency archive <list|show|epic|task|phase>",
		options: {
			...outputOptions,
			...entitySelectorOptions,
			"dry-run": { type: "boolean" },
			kind: { type: "string", multiple: true },
			status: { type: "string", multiple: true },
			repository: { type: "string", multiple: true },
		},
		subcommands: {
			list: {
				usage:
					"agency archive list [--kind <kind>] [--status <status>] [--repository <alias>] [--json]",
				minArgs: 0,
				maxArgs: 0,
				options: ["kind", "status", "repository", "json"],
				repeatable: ["kind", "status", "repository"],
			},
			show: {
				usage:
					"agency archive show <epic|task> <id> | phase <task-id> <phase-id> [--json]",
				minArgs: 2,
				maxArgs: 3,
				options: ["json"],
			},
			epic: {
				usage: "agency archive epic <epic-id> [--dry-run] [--json]",
				minArgs: 1,
				maxArgs: 1,
				options: ["dry-run", "json", "epic"],
			},
			task: {
				usage: "agency archive task <task-id> [--dry-run] [--json]",
				minArgs: 1,
				maxArgs: 1,
				options: ["dry-run", "json", "task"],
			},
			phase: {
				usage: "agency archive phase <task-id> <phase-id> [--dry-run] [--json]",
				minArgs: 2,
				maxArgs: 2,
				options: ["dry-run", "json", "task", "phase"],
			},
		},
	},
	restore: {
		usage: "agency restore <epic|task|phase>",
		options: {
			...outputOptions,
			...entitySelectorOptions,
			"dry-run": { type: "boolean" },
		},
		subcommands: {
			epic: {
				usage: "agency restore epic <epic-id> [--dry-run] [--json]",
				minArgs: 1,
				maxArgs: 1,
				options: ["dry-run", "json", "epic"],
			},
			task: {
				usage: "agency restore task <task-id> [--dry-run] [--json]",
				minArgs: 1,
				maxArgs: 1,
				options: ["dry-run", "json", "task"],
			},
			phase: {
				usage: "agency restore phase <task-id> <phase-id> [--dry-run] [--json]",
				minArgs: 2,
				maxArgs: 2,
				options: ["dry-run", "json", "task", "phase"],
			},
		},
	},
	worktree: {
		usage: "agency worktree <list|inspect|prepare|remove|rebuild|repair>",
		options: {
			...outputOptions,
			...entitySelectorOptions,
			"dry-run": { type: "boolean" },
		},
		subcommands: {
			list: {
				usage: "agency worktree list [--json]",
				minArgs: 0,
				maxArgs: 0,
				options: ["json"],
			},
			inspect: {
				usage: "agency worktree inspect <task-id> [phase-id] [--json]",
				minArgs: 1,
				maxArgs: 2,
				options: ["json", "task", "phase"],
			},
			prepare: {
				usage:
					"agency worktree prepare <task-id> [phase-id] [--dry-run] [--json]",
				minArgs: 1,
				maxArgs: 2,
				options: ["dry-run", "json", "task", "phase"],
			},
			remove: {
				usage:
					"agency worktree remove <task-id> [phase-id] [--dry-run] [--json]",
				minArgs: 1,
				maxArgs: 2,
				options: ["dry-run", "json", "task", "phase"],
			},
			rebuild: {
				usage:
					"agency worktree rebuild <task-id> [phase-id] [--dry-run] [--json]",
				minArgs: 1,
				maxArgs: 2,
				options: ["dry-run", "json", "task", "phase"],
			},
			repair: {
				usage:
					"agency worktree repair <task-id> [phase-id] [--dry-run] [--json]",
				minArgs: 1,
				maxArgs: 2,
				options: ["dry-run", "json", "task", "phase"],
			},
		},
	},
	work: {
		usage:
			"agency work [<directory-or-task-id> | --epic <epic-id>] [--runner <name>] [--auto] | agency work prepare [target] [--dry-run] [--json]",
		options: {
			...commonOptions,
			...entitySelectorOptions,
			json: { type: "boolean" },
			"dry-run": { type: "boolean" },
			runner: { type: "string" },
			auto: { type: "boolean" },
			"print-command": { type: "boolean" },
			opencode: { type: "boolean" },
			claude: { type: "boolean" },
			force: { type: "boolean" },
		},
		command: {
			usage:
				"agency work [<directory-or-task-id> | --epic <epic-id>] [--runner <name>] [--auto] | agency work prepare [target] [--dry-run] [--json]",
			minArgs: 0,
			maxArgs: 2,
			options: [
				"json",
				"dry-run",
				"epic",
				"task",
				"phase",
				"runner",
				"auto",
				"print-command",
				"opencode",
				"claude",
				"force",
			],
			conflicts: [
				["opencode", "claude"],
				["runner", "opencode"],
				["runner", "claude"],
				["epic", "$positional"],
			],
		},
	},
	pr: {
		usage: "agency pr create <task-id> [phase-id]",
		options: {
			...outputOptions,
			draft: { type: "boolean" },
			force: { type: "boolean" },
			task: { type: "string" },
			phase: { type: "string" },
		},
		subcommands: {
			create: {
				usage:
					"agency pr create <task-id> [phase-id] [--draft] [--force] [--json]",
				minArgs: 1,
				maxArgs: 2,
				options: ["draft", "force", "json", "task", "phase"],
			},
		},
	},
	next: {
		usage: "agency next [--select] [--json]",
		options: {
			...outputOptions,
			select: { type: "boolean" },
		},
		command: {
			usage: "agency next [--select] [--json]",
			minArgs: 0,
			maxArgs: 0,
			options: ["select", "json"],
		},
	},
	status: {
		usage: "agency status [filters] [--json]",
		options: { ...outputOptions, ...viewOptions },
		command: {
			usage: "agency status [filters] [--json]",
			minArgs: 0,
			maxArgs: 0,
			options: ["json", ...viewOptionNames],
			repeatable: ["status", "repository"],
			conflicts: viewConflicts,
		},
	},
	doctor: {
		usage: "agency doctor [--json]",
		options: outputOptions,
		command: {
			usage: "agency doctor [--json]",
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
	context: {
		usage: "agency context [target] [--json] [--compact]",
		options: {
			...outputOptions,
			...entitySelectorOptions,
			compact: { type: "boolean" },
		},
		command: {
			usage: "agency context [target] [--json] [--compact]",
			minArgs: 0,
			maxArgs: 1,
			options: ["json", "compact", "epic", "task", "phase"],
		},
	},
	graph: {
		usage: "agency graph [options]",
		options: {
			...outputOptions,
			jsonl: { type: "boolean" },
			ready: { type: "boolean" },
			blocked: { type: "boolean" },
			status: { type: "string", multiple: true },
			repository: { type: "string", multiple: true },
			kind: { type: "string", multiple: true },
			include: { type: "string", multiple: true },
		},
		command: {
			usage: "agency graph [options]",
			minArgs: 0,
			maxArgs: 0,
			options: [
				"json",
				"jsonl",
				"ready",
				"blocked",
				"status",
				"repository",
				"kind",
				"include",
			],
			repeatable: ["status", "repository", "kind", "include"],
			conflicts: [
				["json", "jsonl"],
				["ready", "blocked"],
			],
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
const preCommandValueOptions = new Set(["--workbase", "--cwd"])

export interface ParsedCli {
	readonly commandName?: keyof typeof commands
	readonly args: string[]
	readonly values: Record<
		string,
		boolean | string | (boolean | string)[] | undefined
	>
}

class CliUsageError extends Error {
	readonly _tag = "CliUsageError"

	constructor(
		readonly detail: string,
		readonly usage: string,
	) {
		super(`${detail}\n\nUsage: ${usage}`)
		this.name = "CliUsageError"
	}
}

const usageError = (message: string, usage: string) =>
	new CliUsageError(message, usage)

const optionLabel = (name: string) => `--${name}`

function findCommandIndex(args: readonly string[]) {
	for (let index = 0; index < args.length; index++) {
		const argument = args[index]!
		if (!argument.startsWith("-")) return index
		if (argument.startsWith("--workbase=") || argument.startsWith("--cwd=")) {
			continue
		}
		if (preCommandValueOptions.has(argument)) {
			if (args[index + 1] === undefined) {
				throw usageError(
					`Option '${argument}' expects a value.`,
					"agency <command> [options]",
				)
			}
			index++
			continue
		}
		if (!preCommandOptions.has(argument) && !/^-[hVsv]+$/.test(argument)) {
			throw usageError(
				`Unknown option '${argument}'.`,
				"agency <command> [options]",
			)
		}
	}
	return -1
}

const targetSlots = (
	commandName: string,
	subcommand: string | undefined,
): readonly ("epic" | "task" | "phase")[] => {
	if (commandName === "epic" && subcommand === "show") return ["epic"]
	if (commandName === "task" && ["show", "status"].includes(subcommand ?? ""))
		return ["task"]
	if (commandName === "phase")
		return subcommand === "list" ? ["task"] : ["task", "phase"]
	if (["claim", "release", "finish"].includes(commandName))
		return ["task", "phase"]
	if (["archive", "restore"].includes(commandName))
		return subcommand === "epic"
			? ["epic"]
			: subcommand === "task"
				? ["task"]
				: subcommand === "phase"
					? ["task", "phase"]
					: []
	if (commandName === "worktree" && subcommand !== "list") {
		return ["task", "phase"]
	}
	if (commandName === "pr" && subcommand === "create") return ["task", "phase"]
	return []
}

function applyEntitySelectors(
	commandName: string,
	subcommand: string | undefined,
	positionals: readonly string[],
	values: ParsedCli["values"],
	spec: LeafCommand,
) {
	const supplied = ["epic", "task", "phase"].filter(
		(name) => values[name] !== undefined,
	)
	if (supplied.length === 0) return [...positionals]
	if (values.phase !== undefined && values.task === undefined) {
		throw usageError("Option '--phase' requires '--task'.", spec.usage)
	}
	if (values.epic !== undefined && (values.task || values.phase)) {
		throw usageError(
			"Option '--epic' cannot be combined with '--task' or '--phase'.",
			spec.usage,
		)
	}
	if (commandName === "work" || commandName === "context") {
		if (
			positionals.length >
			(commandName === "work" && positionals[0] === "prepare" ? 1 : 0)
		) {
			throw usageError(
				"Entity selector options cannot be combined with a positional target.",
				spec.usage,
			)
		}
		return [...positionals]
	}

	const slots = targetSlots(commandName, subcommand)
	const selectedSlots = slots.filter((slot) => values[slot] !== undefined)
	if (selectedSlots.length === 0) return [...positionals]
	const trailingCount = spec.maxArgs - slots.length
	if (positionals.length > trailingCount) {
		throw usageError(
			"Entity selector options cannot be combined with positional target IDs.",
			spec.usage,
		)
	}
	const requiredSlots = slots.slice(0, spec.minArgs - trailingCount)
	for (const slot of requiredSlots) {
		if (values[slot] === undefined) {
			throw usageError(
				`Option '--${slot}' is required with explicit selectors.`,
				spec.usage,
			)
		}
	}
	return [
		...slots.flatMap((slot) =>
			typeof values[slot] === "string" ? [values[slot] as string] : [],
		),
		...positionals,
	]
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

function validateGraphOptions(values: ParsedCli["values"], spec: LeafCommand) {
	const allowed = {
		status: new Set(["open", "working", "delegated", "done", "dropped"]),
		kind: new Set(["epic", "task", "phase", "repository", "execution-unit"]),
		include: new Set(["bodies", "workspace", "git", "pr"]),
	}
	for (const [name, accepted] of Object.entries(allowed)) {
		const supplied = values[name]
		const entries = Array.isArray(supplied)
			? supplied
			: supplied === undefined
				? []
				: [supplied]
		for (const value of entries) {
			if (typeof value !== "string" || !accepted.has(value)) {
				throw usageError(
					`Invalid '${optionLabel(name)}' value '${String(value)}'. Expected one of: ${[...accepted].join(", ")}.`,
					spec.usage,
				)
			}
		}
	}
}

function validateViewOptions(values: ParsedCli["values"], spec: LeafCommand) {
	const supplied = values.status
	const statuses = Array.isArray(supplied)
		? supplied
		: supplied === undefined
			? []
			: [supplied]
	const accepted = new Set(["open", "working", "delegated", "done", "dropped"])
	for (const status of statuses) {
		if (typeof status !== "string" || !accepted.has(status)) {
			throw usageError(
				`Invalid '--status' value '${String(status)}'. Expected one of: ${[...accepted].join(", ")}.`,
				spec.usage,
			)
		}
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

	let commandPositionals = definition.subcommands
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
	for (const selector of ["workbase", "cwd", "epic", "task", "phase"]) {
		if (parsed.values[selector] === "") {
			throw usageError(
				`Option '--${selector}' requires a non-empty value.`,
				spec.usage,
			)
		}
	}
	if (parsed.values.workbase && parsed.values.cwd) {
		throw usageError(
			"Options '--workbase' and '--cwd' cannot be combined.",
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

	commandPositionals = applyEntitySelectors(
		commandName,
		subcommand,
		commandPositionals,
		parsed.values,
		spec,
	)

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
	if (
		["epic", "task", "phase"].includes(commandName) &&
		subcommand === "new" &&
		parsed.values.auto &&
		!parsed.values.work
	) {
		throw usageError("Option '--auto' requires '--work'.", spec.usage)
	}
	if (["task", "phase"].includes(commandName) && subcommand === "dependency") {
		if (!["add", "remove"].includes(commandPositionals[0] ?? "")) {
			throw usageError(
				"Dependency operation must be 'add' or 'remove'.",
				spec.usage,
			)
		}
	}
	if (commandName === "task" && subcommand === "move") {
		if (
			parsed.values.epic === undefined &&
			parsed.values["no-epic"] === undefined
		) {
			throw usageError(
				"One of '--epic' or '--no-epic' is required.",
				spec.usage,
			)
		}
	}
	if (
		["epic", "task", "phase"].includes(commandName) &&
		subcommand === "update"
	) {
		const mutationNames = (spec.options ?? []).filter(
			(name) => name !== "json" && name !== "if-revision",
		)
		if (!mutationNames.some((name) => parsed.values[name] !== undefined)) {
			throw usageError("At least one update option is required.", spec.usage)
		}
	}
	if (
		typeof parsed.values["if-revision"] === "string" &&
		!/^[a-f0-9]{64}$/.test(parsed.values["if-revision"])
	) {
		throw usageError(
			"Option '--if-revision' must be a 64-character SHA-256 hash.",
			spec.usage,
		)
	}
	if (commandName === "graph") {
		validateGraphOptions(parsed.values, spec)
	}
	if (
		commandName === "status" ||
		(commandName === "archive" && subcommand === "list") ||
		(["epic", "task", "phase"].includes(commandName) && subcommand === "list")
	) {
		validateViewOptions(parsed.values, spec)
	}
	if (
		commandName === "finish" &&
		parsed.values.outcome !== "done" &&
		parsed.values.outcome !== "dropped"
	) {
		throw usageError(
			"Option '--outcome' must be 'done' or 'dropped'.",
			spec.usage,
		)
	}
	if (commandName === "work") {
		const preparing = commandPositionals[0] === "prepare"
		if (
			(!preparing && commandPositionals.length > 1) ||
			(preparing &&
				(parsed.values.epic ||
					parsed.values.opencode ||
					parsed.values.claude ||
					parsed.values.runner ||
					parsed.values.auto ||
					parsed.values["print-command"] ||
					parsed.values.force))
		) {
			throw usageError(
				preparing
					? "Work preparation cannot be combined with agent or epic options."
					: "The work command accepts at most one target.",
				spec.usage,
			)
		}
		if (!preparing && (parsed.values.json || parsed.values["dry-run"])) {
			throw usageError(
				"Options '--json' and '--dry-run' are only valid with 'agency work prepare'.",
				spec.usage,
			)
		}
	}

	return {
		commandName: commandName as keyof typeof commands,
		args: definition.subcommands
			? [subcommand!, ...commandPositionals]
			: commandPositionals,
		values: parsed.values,
	}
}
