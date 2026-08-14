interface WorkspaceCommandVariables {
	readonly repo: string
	readonly workspace: string
	readonly name: string
	readonly revision: string
	readonly kind: "writable" | "reference"
	readonly requestedRef: string
}

const REQUIRED_PLACEHOLDERS = ["repo", "workspace", "name", "revision"] as const
const PLACEHOLDERS = new Set([
	"repo",
	"workspace",
	"name",
	"revision",
	"kind",
	"requestedRef",
])

export const validateWorkspaceCreateCommand = (command: readonly string[]) => {
	const template = command.join("\u0000")
	for (const placeholder of REQUIRED_PLACEHOLDERS) {
		if (!template.includes(`{${placeholder}}`)) {
			throw new Error(
				`workspaceCreateCommand must include the {${placeholder}} placeholder`,
			)
		}
	}
	for (const argument of command) {
		for (const match of argument.matchAll(/\{([^{}]+)\}/g)) {
			const placeholder = match[1]!
			if (!PLACEHOLDERS.has(placeholder)) {
				throw new Error(
					`Unknown workspaceCreateCommand placeholder: {${placeholder}}`,
				)
			}
		}
	}
}

export const expandWorkspaceCreateCommand = (
	command: readonly string[],
	variables: WorkspaceCommandVariables,
): string[] => {
	validateWorkspaceCreateCommand(command)

	return command.map((argument) =>
		argument.replaceAll(/\{([^{}]+)\}/g, (match, placeholder: string) => {
			return variables[placeholder as keyof WorkspaceCommandVariables] ?? match
		}),
	)
}

export const workspaceCommandEnvironment = (
	variables: WorkspaceCommandVariables,
): Record<string, string> => ({
	AGENCY_REPO: variables.repo,
	AGENCY_WORKSPACE: variables.workspace,
	AGENCY_WORKSPACE_NAME: variables.name,
	AGENCY_REVISION: variables.revision,
	AGENCY_CHECKOUT_KIND: variables.kind,
	AGENCY_REQUESTED_REF: variables.requestedRef,
})
