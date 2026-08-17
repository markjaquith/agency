import type { WorkbaseConfig } from "./schemas"

export interface AgentCommandVariables {
	readonly prompt: string
	readonly workbase: string
	readonly target: string
	readonly task: string
	readonly phase: string
	readonly claimant: string
	readonly sessionId: string
	readonly claimRevision: string
}

interface AgentDefinition {
	readonly command: readonly string[]
	readonly autoCommand?: readonly string[]
	readonly resumeCommand?: readonly string[]
	readonly autoResumeCommand?: readonly string[]
	readonly environment?: Readonly<Record<string, string>>
}

const PLACEHOLDERS = new Set<keyof AgentCommandVariables>([
	"prompt",
	"workbase",
	"target",
	"task",
	"phase",
	"claimant",
	"sessionId",
	"claimRevision",
])

const BUILTIN_AGENTS: Readonly<Record<string, AgentDefinition>> = {
	opencode2: {
		command: ["opencode2"],
		autoCommand: ["opencode2", "--prompt", "{prompt}"],
		resumeCommand: ["opencode2", "--continue"],
		autoResumeCommand: ["opencode2", "--continue", "--prompt", "{prompt}"],
	},
	opencode: {
		command: ["opencode"],
		autoCommand: ["opencode", "--prompt", "{prompt}"],
		resumeCommand: ["opencode", "--continue"],
		autoResumeCommand: ["opencode", "--continue", "--prompt", "{prompt}"],
	},
	pi: {
		command: ["pi"],
		autoCommand: ["pi", "{prompt}"],
		resumeCommand: ["pi", "--continue"],
		autoResumeCommand: ["pi", "--continue", "{prompt}"],
	},
	claude: {
		command: ["claude"],
		autoCommand: ["claude", "{prompt}"],
		resumeCommand: ["claude", "--continue"],
		autoResumeCommand: ["claude", "--continue", "{prompt}"],
	},
}

const validateTemplate = (agent: string, value: string) => {
	for (const match of value.matchAll(/\{([^{}]+)\}/g)) {
		const placeholder = match[1]!
		if (!PLACEHOLDERS.has(placeholder as keyof AgentCommandVariables)) {
			throw new Error(`Unknown agent '${agent}' placeholder: {${placeholder}}`)
		}
	}
}

export const validateAgents = (agents: WorkbaseConfig["agents"]): void => {
	for (const [name, agent] of Object.entries(agents ?? {})) {
		for (const value of [
			...agent.command,
			...(agent.autoCommand ?? []),
			...(agent.resumeCommand ?? []),
			...(agent.autoResumeCommand ?? []),
			...Object.values(agent.environment ?? {}),
		]) {
			validateTemplate(name, value)
		}
	}
}

const expand = (value: string, variables: AgentCommandVariables) =>
	value.replaceAll(
		/\{([^{}]+)\}/g,
		(match, placeholder: string) =>
			variables[placeholder as keyof AgentCommandVariables] ?? match,
	)

export const resolveAgentCommand = (
	name: string,
	configured: WorkbaseConfig["agents"],
	variables: AgentCommandVariables,
	resume: boolean,
	auto = false,
) => {
	validateAgents(configured)
	const definition = configured?.[name] ?? BUILTIN_AGENTS[name]
	if (!definition) throw new Error(`Unknown agent: ${name}`)
	const template = auto
		? resume
			? (definition.autoResumeCommand ?? definition.autoCommand)
			: definition.autoCommand
		: resume && definition.resumeCommand
			? definition.resumeCommand
			: definition.command
	if (!template) {
		throw new Error(`Agent '${name}' does not support --auto`)
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

export const agentEnvironment = (
	agent: string,
	variables: AgentCommandVariables,
): Record<string, string> => ({
	AGENCY_AGENT: agent,
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
