export interface BranchNameVariables {
	readonly id: string
	readonly ticket: string
	readonly ticketUrl: string
	readonly repo: string
	readonly base: string
	readonly workbaseRoot: string
	readonly taskId: string
	readonly phaseId: string
}

const PLACEHOLDERS = new Set<keyof BranchNameVariables>([
	"id",
	"ticket",
	"ticketUrl",
	"repo",
	"base",
	"workbaseRoot",
	"taskId",
	"phaseId",
])

export const validateBranchNameCommand = (command: readonly string[]) => {
	for (const argument of command) {
		for (const match of argument.matchAll(/\{([^{}]+)\}/g)) {
			const placeholder = match[1]!
			if (!PLACEHOLDERS.has(placeholder as keyof BranchNameVariables)) {
				throw new Error(
					`Unknown branchNameCommand placeholder: {${placeholder}}`,
				)
			}
		}
	}
}

export const expandBranchNameCommand = (
	command: readonly string[],
	variables: BranchNameVariables,
): string[] => {
	validateBranchNameCommand(command)
	return command.map((argument) =>
		argument.replaceAll(
			/\{([^{}]+)\}/g,
			(match, placeholder: string) =>
				variables[placeholder as keyof BranchNameVariables] ?? match,
		),
	)
}
