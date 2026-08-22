export interface CheckoutCommandVariables {
	readonly repoAlias: string
	readonly repositoryPath: string
	readonly checkoutPath: string
	readonly checkoutKind: "writable" | "reference"
	readonly requestedRef: string
	readonly base: string
	readonly vcs: "git"
	readonly workbaseRoot: string
	readonly taskId: string
	readonly phaseId: string
}

const PLACEHOLDERS = new Set<keyof CheckoutCommandVariables>([
	"repoAlias",
	"repositoryPath",
	"checkoutPath",
	"checkoutKind",
	"requestedRef",
	"base",
	"vcs",
	"workbaseRoot",
	"taskId",
	"phaseId",
])

export const validatePostCheckoutCommand = (command: readonly string[]) => {
	for (const argument of command) {
		for (const match of argument.matchAll(/\{([^{}]+)\}/g)) {
			const placeholder = match[1]!
			if (!PLACEHOLDERS.has(placeholder as keyof CheckoutCommandVariables)) {
				throw new Error(
					`Unknown postCheckoutCommand placeholder: {${placeholder}}`,
				)
			}
		}
	}
}

export const expandPostCheckoutCommand = (
	command: readonly string[],
	variables: CheckoutCommandVariables,
): string[] => {
	validatePostCheckoutCommand(command)

	return command.map((argument) =>
		argument.replaceAll(/\{([^{}]+)\}/g, (match, placeholder: string) => {
			return variables[placeholder as keyof CheckoutCommandVariables] ?? match
		}),
	)
}

export const postCheckoutCommandEnvironment = (
	variables: CheckoutCommandVariables,
): Record<string, string> => ({
	AGENCY_REPO_ALIAS: variables.repoAlias,
	AGENCY_REPOSITORY_PATH: variables.repositoryPath,
	AGENCY_CHECKOUT_PATH: variables.checkoutPath,
	AGENCY_CHECKOUT_KIND: variables.checkoutKind,
	AGENCY_REQUESTED_REF: variables.requestedRef,
	AGENCY_BASE: variables.base,
	AGENCY_VCS: variables.vcs,
	AGENCY_WORKBASE_ROOT: variables.workbaseRoot,
	AGENCY_TASK_ID: variables.taskId,
	AGENCY_PHASE_ID: variables.phaseId,
})
