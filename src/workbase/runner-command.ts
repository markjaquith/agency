import type { WorkbaseConfig } from "./schemas"

export interface RunnerCommandVariables {
	readonly prompt: string
	readonly workbase: string
	readonly target: string
	readonly task: string
	readonly phase: string
	readonly claimant: string
	readonly sessionId: string
	readonly claimRevision: string
}

interface RunnerDefinition {
	readonly command: readonly string[]
	readonly autoCommand?: readonly string[]
	readonly resumeCommand?: readonly string[]
	readonly autoResumeCommand?: readonly string[]
	readonly environment?: Readonly<Record<string, string>>
}

const PLACEHOLDERS = new Set<keyof RunnerCommandVariables>([
	"prompt",
	"workbase",
	"target",
	"task",
	"phase",
	"claimant",
	"sessionId",
	"claimRevision",
])

const BUILTIN_RUNNERS: Readonly<Record<string, RunnerDefinition>> = {
	opencode: {
		command: ["opencode"],
		autoCommand: ["opencode", "--prompt", "{prompt}"],
		resumeCommand: ["opencode", "--continue"],
		autoResumeCommand: ["opencode", "--continue", "--prompt", "{prompt}"],
	},
	claude: {
		command: ["claude"],
		autoCommand: ["claude", "{prompt}"],
		resumeCommand: ["claude", "--continue"],
		autoResumeCommand: ["claude", "--continue", "{prompt}"],
	},
}

const validateTemplate = (runner: string, value: string) => {
	for (const match of value.matchAll(/\{([^{}]+)\}/g)) {
		const placeholder = match[1]!
		if (!PLACEHOLDERS.has(placeholder as keyof RunnerCommandVariables)) {
			throw new Error(
				`Unknown runner '${runner}' placeholder: {${placeholder}}`,
			)
		}
	}
}

export const validateRunners = (runners: WorkbaseConfig["runners"]): void => {
	for (const [name, runner] of Object.entries(runners ?? {})) {
		for (const value of [
			...runner.command,
			...(runner.autoCommand ?? []),
			...(runner.resumeCommand ?? []),
			...(runner.autoResumeCommand ?? []),
			...Object.values(runner.environment ?? {}),
		]) {
			validateTemplate(name, value)
		}
	}
}

const expand = (value: string, variables: RunnerCommandVariables) =>
	value.replaceAll(
		/\{([^{}]+)\}/g,
		(match, placeholder: string) =>
			variables[placeholder as keyof RunnerCommandVariables] ?? match,
	)

export const resolveRunnerCommand = (
	name: string,
	configured: WorkbaseConfig["runners"],
	variables: RunnerCommandVariables,
	resume: boolean,
	auto = false,
) => {
	validateRunners(configured)
	const definition = configured?.[name] ?? BUILTIN_RUNNERS[name]
	if (!definition) throw new Error(`Unknown runner: ${name}`)
	const template = auto
		? resume
			? (definition.autoResumeCommand ?? definition.autoCommand)
			: definition.autoCommand
		: resume && definition.resumeCommand
			? definition.resumeCommand
			: definition.command
	if (!template) {
		throw new Error(`Runner '${name}' does not support --auto`)
	}
	const argv = template.map((argument) => expand(argument, variables))
	const environment = Object.fromEntries(
		Object.entries(definition.environment ?? {}).map(([key, value]) => [
			key,
			expand(value, variables),
		]),
	)
	return { argv, environment }
}

export const runnerEnvironment = (
	runner: string,
	variables: RunnerCommandVariables,
): Record<string, string> => ({
	AGENCY_RUNNER: runner,
	AGENCY_CLAIMANT: variables.claimant,
	AGENCY_SESSION_ID: variables.sessionId,
	AGENCY_CLAIM_REVISION: variables.claimRevision,
	AGENCY_WORKBASE: variables.workbase,
	AGENCY_TARGET: variables.target,
	AGENCY_TASK_ID: variables.task,
	AGENCY_PHASE_ID: variables.phase,
	AGENCY_PROMPT: variables.prompt,
})

const SECRET_NAME =
	/(secret|token|password|credential|api[_-]?key|private[_-]?key)/i

export const printableEnvironment = (environment: Record<string, string>) =>
	Object.fromEntries(
		Object.entries(environment)
			.filter(([key]) => !SECRET_NAME.test(key))
			.sort(([left], [right]) => left.localeCompare(right)),
	)
