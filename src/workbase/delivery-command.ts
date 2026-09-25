import { Schema, TreeFormatter } from "@effect/schema"
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

export const repositoryFromRemote = (remote: string) =>
	remote
		.replace(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?[^/]+\//i, "")
		.replace(/^[^:]+:/, "")
		.replace(/\.git\/?$/, "")
		.replace(/\/$/, "")

export const resolveGitHubCreateCommand = ({
	repository,
	base,
	draft,
	title,
	head,
	labels = [],
}: {
	readonly repository: string
	readonly base: string
	readonly draft: boolean
	readonly title?: string
	readonly head: string
	readonly labels?: readonly string[]
}) => ({
	argv: [
		"gh",
		"pr",
		"create",
		...(title ? ["--fill", "--title", title] : ["--fill"]),
		"--repo",
		repository,
		"--base",
		base,
		"--head",
		head,
		...(draft ? ["--draft"] : []),
		...labels.flatMap((label) => ["--label", label]),
	],
	environment: {},
})

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

const GitHubRepository = Schema.Struct({
	nameWithOwner: Schema.String.pipe(Schema.minLength(1)),
})

const GitHubPullRequest = Schema.Struct({
	number: Schema.Number,
	state: Schema.Literal("OPEN", "CLOSED", "MERGED"),
	title: Schema.optional(Schema.String),
	isDraft: Schema.Boolean,
	headRefName: Schema.String,
	baseRefName: Schema.String,
	headRepository: Schema.NullOr(GitHubRepository),
	baseRepository: Schema.optional(Schema.NullOr(GitHubRepository)),
	url: Schema.String,
	mergedAt: Schema.optional(Schema.NullOr(Schema.String)),
	mergeCommit: Schema.optional(
		Schema.NullOr(Schema.Struct({ oid: Schema.String })),
	),
	mergeable: Schema.Literal("MERGEABLE", "CONFLICTING", "UNKNOWN"),
})

const decodeGitHubPullRequest = Schema.decodeUnknownEither(GitHubPullRequest)
const decodeGitHubPullRequests = Schema.decodeUnknownEither(
	Schema.Array(GitHubPullRequest),
)

const invalidGitHubResponse = (
	kind: "pull request" | "pull request list",
	error: Parameters<typeof TreeFormatter.formatErrorSync>[0],
) =>
	new Error(
		`GitHub CLI did not return a valid ${kind}: ${TreeFormatter.formatErrorSync(error)}`,
	)

const recordFromGitHubJson = (value: unknown): PullRequestRecord => {
	const decoded = decodeGitHubPullRequest(value)
	if (decoded._tag === "Left") {
		throw invalidGitHubResponse("pull request", decoded.left)
	}
	const detail = decoded.right
	const record = recordFromGitHubUrl(detail.url)
	const repositoryName = (repository: unknown) => {
		if (!repository || typeof repository !== "object") return undefined
		const nameWithOwner = (repository as Record<string, unknown>).nameWithOwner
		return typeof nameWithOwner === "string" && nameWithOwner
			? nameWithOwner
			: undefined
	}
	const githubState = detail.state.toLowerCase()
	const merged = githubState === "merged" || detail.mergedAt != null
	const mergeable = detail.mergeable.toLowerCase()
	return {
		...record,
		headRepository: repositoryName(detail.headRepository),
		headBranch: detail.headRefName,
		baseRepository: repositoryName(detail.baseRepository) ?? record.repository,
		baseBranch: detail.baseRefName,
		state: merged ? "merged" : githubState === "closed" ? "closed" : "open",
		draft: detail.isDraft,
		merged,
		mergeable:
			mergeable === "mergeable"
				? true
				: mergeable === "conflicting"
					? false
					: null,
	} satisfies PullRequestRecord
}

const parseJson = (
	value: string,
	kind: "pull request" | "pull request list",
) => {
	try {
		return JSON.parse(value) as unknown
	} catch {
		throw new Error(`GitHub CLI did not return valid JSON for ${kind}`)
	}
}

export const parseGitHubPullRequest = (value: string): PullRequestRecord =>
	recordFromGitHubJson(parseJson(value, "pull request"))

export const parseGitHubPullRequestList = (
	value: string,
): readonly PullRequestRecord[] => {
	const decoded = decodeGitHubPullRequests(
		parseJson(value, "pull request list"),
	)
	if (decoded._tag === "Left") {
		throw invalidGitHubResponse("pull request list", decoded.left)
	}
	return decoded.right.map(recordFromGitHubJson)
}

export const normalizePullRequestRecord = (
	record: PullRequestRecord | string,
): PullRequestRecord =>
	typeof record === "string" ? recordFromGitHubUrl(record) : record
