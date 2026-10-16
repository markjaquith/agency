import { Effect, Schema } from "effect"
import {
	parseUrl,
	runJsonCommand,
	type TicketProvider,
	type TicketStatusCategory,
} from "./provider"

const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-\d+$/

const JiraWorkItem = Schema.Struct({
	key: Schema.String,
	fields: Schema.Struct({
		summary: Schema.String,
		status: Schema.Struct({
			name: Schema.String,
			statusCategory: Schema.Struct({ key: Schema.String }),
		}),
		resolution: Schema.optional(
			Schema.NullOr(Schema.Struct({ name: Schema.String })),
		),
	}),
})

const statusCategory = (key: string): TicketStatusCategory =>
	key === "done" ? "done" : key === "indeterminate" ? "in_progress" : "todo"

const decodePathSegment = (segment: string | undefined) => {
	if (!segment) return null
	try {
		return decodeURIComponent(segment)
	} catch {
		return null
	}
}

const issueKey = (url: URL) => {
	const candidates = [
		url.searchParams.get("selectedIssue"),
		decodePathSegment(url.pathname.match(/\/browse\/([^/]+)\/?$/)?.[1]),
		decodePathSegment(url.pathname.match(/\/issues\/([^/]+)\/?$/)?.[1]),
	]
	for (const candidate of candidates) {
		const key = candidate?.toUpperCase()
		if (key && ISSUE_KEY.test(key)) return key
	}
	return null
}

export const jiraTicketProvider: TicketProvider = {
	id: "jira",
	resolve: (value) => {
		const url = parseUrl(value)
		if (!url || url.protocol !== "https:") return null
		if (!url.hostname.endsWith(".atlassian.net")) return null
		const key = issueKey(url)
		return key ? { provider: "jira", key, url: value } : null
	},
	read: (reference) =>
		runJsonCommand(
			"jira",
			[
				"acli",
				"jira",
				"workitem",
				"view",
				reference.key,
				"--fields",
				"summary,status,resolution",
				"--json",
			],
			JiraWorkItem,
		).pipe(
			Effect.map((item) => ({
				key: item.key,
				url: reference.url,
				status: item.fields.status.name,
				statusCategory: statusCategory(item.fields.status.statusCategory.key),
				summary: item.fields.summary,
				resolution: item.fields.resolution?.name ?? null,
			})),
		),
	transitions: () =>
		Effect.succeed({
			supported: false,
			reason:
				"acli cannot list Jira workflow transitions; transition by target status name instead",
		}),
}
