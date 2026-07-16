interface WorktreeCommandVariables {
	readonly repo: string
	readonly worktree: string
	readonly branch: string
	readonly base: string
}

const REQUIRED_PLACEHOLDERS = ["repo", "worktree"] as const
const PLACEHOLDERS = new Set(["repo", "worktree", "branch", "base"])

export const validateWorktreeCreateCommand = (command: readonly string[]) => {
	const template = command.join("\u0000")
	for (const placeholder of REQUIRED_PLACEHOLDERS) {
		if (!template.includes(`{${placeholder}}`)) {
			throw new Error(
				`worktreeCreateCommand must include the {${placeholder}} placeholder`,
			)
		}
	}
	for (const argument of command) {
		for (const match of argument.matchAll(/\{([^{}]+)\}/g)) {
			const placeholder = match[1]!
			if (!PLACEHOLDERS.has(placeholder)) {
				throw new Error(
					`Unknown worktreeCreateCommand placeholder: {${placeholder}}`,
				)
			}
		}
	}
}

export const expandWorktreeCreateCommand = (
	command: readonly string[],
	variables: WorktreeCommandVariables,
): string[] => {
	validateWorktreeCreateCommand(command)

	return command.map((argument) =>
		argument.replaceAll(/\{([^{}]+)\}/g, (match, placeholder: string) => {
			return variables[placeholder as keyof WorktreeCommandVariables] ?? match
		}),
	)
}

export const worktreeCommandEnvironment = (
	variables: WorktreeCommandVariables,
): Record<string, string> => ({
	AGENCY_REPO: variables.repo,
	AGENCY_WORKTREE: variables.worktree,
	AGENCY_BRANCH: variables.branch,
	AGENCY_BASE: variables.base,
})
