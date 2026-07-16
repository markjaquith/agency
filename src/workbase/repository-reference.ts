import type { RepositoryReference } from "./schemas"

const parseRepositoryReference = (value: string): RepositoryReference => {
	const separator = value.indexOf(":")
	if (separator <= 0 || separator === value.length - 1) {
		throw new Error(
			`Invalid repository reference '${value}'; expected <alias>:<ref>`,
		)
	}

	return {
		repo: value.slice(0, separator),
		ref: value.slice(separator + 1),
	}
}

export const parseRepositoryReferences = (values: readonly string[] = []) =>
	values.map(parseRepositoryReference)
