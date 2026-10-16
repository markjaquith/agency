import { Effect, Schema } from "effect"
import {
	parseUrl,
	runJsonCommand,
	type TicketProvider,
	type TicketReference,
	type TicketTransition,
} from "./provider"

const GitHubIssue = Schema.Struct({
	number: Schema.Number,
	title: Schema.String,
	state: Schema.String,
	stateReason: Schema.optional(Schema.NullOr(Schema.String)),
	url: Schema.String,
})

const location = (reference: TicketReference) => {
	const match = reference.key.match(/^(.+)#(\d+)$/)!
	return { repository: match[1]!, number: match[2]! }
}

const read = (reference: TicketReference) => {
	const { repository, number } = location(reference)
	return runJsonCommand(
		"github",
		[
			"gh",
			"issue",
			"view",
			number,
			"--repo",
			repository,
			"--json",
			"number,title,state,stateReason,url",
		],
		GitHubIssue,
	).pipe(
		Effect.map((issue) => {
			const closed = issue.state.toUpperCase() === "CLOSED"
			return {
				key: reference.key,
				url: reference.url,
				status: issue.state.toUpperCase(),
				statusCategory: closed ? ("done" as const) : ("todo" as const),
				summary: issue.title,
				resolution: closed ? issue.stateReason?.toUpperCase() || null : null,
			}
		}),
	)
}

const closeTransitions: readonly TicketTransition[] = [
	{
		id: "close",
		name: "Close as completed",
		toStatus: "CLOSED",
		toStatusCategory: "done",
	},
	{
		id: "close-not-planned",
		name: "Close as not planned",
		toStatus: "CLOSED",
		toStatusCategory: "done",
	},
]

const reopenTransitions: readonly TicketTransition[] = [
	{ id: "reopen", name: "Reopen", toStatus: "OPEN", toStatusCategory: "todo" },
]

export const githubTicketProvider: TicketProvider = {
	id: "github",
	resolve: (value) => {
		const url = parseUrl(value)
		if (!url || url.protocol !== "https:" || url.hostname !== "github.com") {
			return null
		}
		const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/)
		return match
			? {
					provider: "github",
					key: `${match[1]}/${match[2]}#${match[3]}`,
					url: value,
				}
			: null
	},
	read,
	transitions: (reference) =>
		read(reference).pipe(
			Effect.map((ticket) => ({
				supported: true as const,
				transitions:
					ticket.statusCategory === "done"
						? reopenTransitions
						: closeTransitions,
			})),
		),
}
