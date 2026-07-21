import { describe, expect, test } from "bun:test"
import {
	parsePullRequestRecord,
	recordFromGitHubJson,
	resolveDeliveryCommand,
	validateDelivery,
} from "./delivery-command"

const delivery = {
	provider: "forge",
	remote: "upstream",
	createCommand: ["forge", "create", "{repository}", "{branch}"],
	queryCommand: ["forge", "query", "{identifier}"],
	environment: { FORGE_BASE: "{base}" },
} as const

const variables = {
	repository: "example/agency",
	branch: "feat/example",
	base: "main",
	draft: "false",
	url: "",
	identifier: "",
}

describe("delivery commands", () => {
	test("expands argv and environment without shell evaluation", () => {
		expect(resolveDeliveryCommand(delivery, "create", variables)).toEqual({
			argv: ["forge", "create", "example/agency", "feat/example"],
			environment: { FORGE_BASE: "main" },
		})
	})

	test("rejects unknown placeholders", () => {
		expect(() =>
			validateDelivery({ ...delivery, queryCommand: ["forge", "{unknown}"] }),
		).toThrow("Unknown delivery provider 'forge' placeholder")
	})

	test("requires complete and consistent normalized records", () => {
		const record = {
			provider: "forge",
			repository: "example/agency",
			identifier: "17",
			url: "https://forge.example/example/agency/pulls/17",
			state: "merged",
			draft: false,
			merged: true,
		} as const
		expect(parsePullRequestRecord(JSON.stringify(record))).toEqual(record)
		expect(() =>
			parsePullRequestRecord(JSON.stringify({ ...record, merged: false })),
		).toThrow("inconsistent merge state")
		expect(
			parsePullRequestRecord(JSON.stringify({ ...record, mergeable: null })),
		).toEqual({ ...record, mergeable: null })
		expect(() =>
			parsePullRequestRecord(JSON.stringify({ ...record, mergeable: "yes" })),
		).toThrow("valid pull request record")
	})

	test("normalizes GitHub state and mergeability", () => {
		const base = {
			number: 17,
			url: "https://github.com/example/agency/pull/17",
			isDraft: false,
		}
		expect(
			recordFromGitHubJson({ ...base, state: "OPEN", mergeable: "MERGEABLE" }),
		).toMatchObject({ state: "open", merged: false, mergeable: true })
		expect(
			recordFromGitHubJson({
				...base,
				state: "OPEN",
				mergeable: "CONFLICTING",
			}),
		).toMatchObject({ state: "open", merged: false, mergeable: false })
		expect(
			recordFromGitHubJson({
				...base,
				state: "CLOSED",
				mergedAt: "2026-07-21T00:00:00Z",
				mergeable: "UNKNOWN",
			}),
		).toMatchObject({ state: "merged", merged: true, mergeable: null })
	})
})
