interface WorktreeCommandVariables {
	readonly repo: string
	readonly worktree: string
	readonly branch: string
	readonly base: string
}

type WorktreeCommandSetting = "worktreeCreateCommand" | "worktreeRemoveCommand"

const REQUIRED_PLACEHOLDERS = ["repo", "worktree"] as const
const PLACEHOLDERS = new Set(["repo", "worktree", "branch", "base"])

export const validateWorktreeCommand = (
	setting: WorktreeCommandSetting,
	command: readonly string[],
) => {
	const template = command.join("\u0000")
	for (const placeholder of REQUIRED_PLACEHOLDERS) {
		if (!template.includes(`{${placeholder}}`)) {
			throw new Error(
				`${setting} must include the {${placeholder}} placeholder`,
			)
		}
	}
	for (const argument of command) {
		for (const match of argument.matchAll(/\{([^{}]+)\}/g)) {
			const placeholder = match[1]!
			if (!PLACEHOLDERS.has(placeholder)) {
				throw new Error(`Unknown ${setting} placeholder: {${placeholder}}`)
			}
		}
	}
}

export const expandWorktreeCommand = (
	setting: WorktreeCommandSetting,
	command: readonly string[],
	variables: WorktreeCommandVariables,
): string[] => {
	validateWorktreeCommand(setting, command)

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
