import { describe, expect, test } from "bun:test"
import {
	parsePullRequestRecord,
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
	})
})
