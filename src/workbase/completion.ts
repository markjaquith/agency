import type { CompletionRecord } from "./schemas"

export interface NonPrCompletionInput {
	readonly summary: string
	readonly evidenceUrl?: string
}

export const buildNonPrCompletion = (
	input: NonPrCompletionInput,
	now: Date,
): { readonly value: CompletionRecord } | { readonly error: string } => {
	const summary = input.summary.trim()
	if (!summary) return { error: "Non-PR completion summary must not be empty" }

	const evidenceUrl = input.evidenceUrl?.trim()
	if (evidenceUrl && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(evidenceUrl)) {
		return { error: `Invalid completion evidence URL: ${evidenceUrl}` }
	}

	return {
		value: {
			mode: "non-pr",
			completedAt: now.toISOString(),
			summary,
			...(evidenceUrl ? { evidenceUrl } : {}),
		},
	}
}
