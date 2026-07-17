import { Schema } from "@effect/schema"
import type { PullRequestRecord, WorkbaseConfig } from "./schemas"
import { PullRequestRecord as PullRequestRecordSchema } from "./schemas"

export interface DeliveryCommandVariables {
	readonly repository: string
	readonly branch: string
	readonly base: string
	readonly draft: string
	readonly url: string
	readonly identifier: string
}

const PLACEHOLDERS = new Set<keyof DeliveryCommandVariables>([
	"repository",
	"branch",
	"base",
	"draft",
	"url",
	"identifier",
])

const validateTemplate = (provider: string, value: string) => {
	for (const match of value.matchAll(/\{([^{}]+)\}/g)) {
		const placeholder = match[1]!
		if (!PLACEHOLDERS.has(placeholder as keyof DeliveryCommandVariables)) {
			throw new Error(
				`Unknown delivery provider '${provider}' placeholder: {${placeholder}}`,
			)
		}
	}
}

export const validateDelivery = (
	delivery: WorkbaseConfig["delivery"],
): void => {
	if (!delivery) return
	for (const value of [
		...delivery.createCommand,
		...delivery.queryCommand,
		...Object.values(delivery.environment ?? {}),
	]) {
		validateTemplate(delivery.provider, value)
	}
}

const expand = (value: string, variables: DeliveryCommandVariables) =>
	value.replaceAll(
		/\{([^{}]+)\}/g,
		(match, placeholder: string) =>
			variables[placeholder as keyof DeliveryCommandVariables] ?? match,
	)

export const resolveDeliveryCommand = (
	delivery: NonNullable<WorkbaseConfig["delivery"]>,
	kind: "create" | "query",
	variables: DeliveryCommandVariables,
) => {
	validateDelivery(delivery)
	const template =
		kind === "create" ? delivery.createCommand : delivery.queryCommand
	return {
		argv: template.map((argument) => expand(argument, variables)),
		environment: Object.fromEntries(
			Object.entries(delivery.environment ?? {}).map(([key, value]) => [
				key,
				expand(value, variables),
			]),
		),
	}
}

const decodeRecord = Schema.decodeUnknownEither(PullRequestRecordSchema, {
	onExcessProperty: "error",
})

export const parsePullRequestRecord = (value: string): PullRequestRecord => {
	let input: unknown
	try {
		input = JSON.parse(value)
	} catch {
		throw new Error("Delivery provider did not return valid JSON")
	}
	const decoded = decodeRecord(input)
	if (decoded._tag === "Left") {
		throw new Error(
			"Delivery provider did not return a valid pull request record",
		)
	}
	if (decoded.right.merged !== (decoded.right.state === "merged")) {
		throw new Error("Delivery provider returned inconsistent merge state")
	}
	return decoded.right
}

export const parseOptionalPullRequestRecord = (
	value: string,
): PullRequestRecord | null => {
	if (value.trim() === "null") return null
	return parsePullRequestRecord(value)
}

const GITHUB_URL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/

export const recordFromGitHubUrl = (url: string): PullRequestRecord => {
	const match = url.match(GITHUB_URL)
	if (!match) throw new Error(`Invalid GitHub pull request URL: ${url}`)
	return {
		provider: "github",
		repository: match[1]!,
		identifier: match[2]!,
		url,
		state: "open",
		draft: false,
		merged: false,
	}
}

export const recordFromGitHubJson = (value: Record<string, unknown>) => {
	const url = typeof value.url === "string" ? value.url : ""
	const record = recordFromGitHubUrl(url)
	const state = String(value.state ?? "OPEN").toLowerCase()
	return {
		...record,
		state:
			state === "merged" ? "merged" : state === "closed" ? "closed" : "open",
		draft: value.isDraft === true,
		merged: state === "merged" || value.mergedAt != null,
	} satisfies PullRequestRecord
}

export const normalizePullRequestRecord = (
	record: PullRequestRecord | string,
): PullRequestRecord =>
	typeof record === "string" ? recordFromGitHubUrl(record) : record
