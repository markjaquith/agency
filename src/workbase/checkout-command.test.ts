import { describe, expect, test } from "bun:test"
import {
	expandPostCheckoutCommand,
	postCheckoutCommandEnvironment,
} from "./checkout-command"

const variables = {
	repoAlias: "app",
	repositoryPath: "/work/repos/app",
	checkoutPath: "/work/tasks/example/code/app",
	checkoutKind: "reference" as const,
	requestedRef: "main",
	base: "",
	vcs: "jj" as const,
	workbaseRoot: "/work",
	taskId: "example",
	phaseId: "",
}

describe("post-checkout command templates", () => {
	test("expands all context placeholders without shell interpolation", () => {
		expect(
			expandPostCheckoutCommand(
				[
					"tool",
					"{repoAlias}",
					"{repositoryPath}",
					"{checkoutPath}",
					"{checkoutKind}",
					"{requestedRef}",
					"{base}",
					"{vcs}",
					"{workbaseRoot}",
					"{taskId}",
					"{phaseId}",
				],
				variables,
			),
		).toEqual(["tool", ...Object.values(variables)])
	})

	test("rejects unknown placeholders", () => {
		expect(() =>
			expandPostCheckoutCommand(["tool", "{unknown}"], variables),
		).toThrow("{unknown}")
	})

	test("provides matching environment variables with empty optional values", () => {
		expect(postCheckoutCommandEnvironment(variables)).toEqual({
			AGENCY_REPO_ALIAS: variables.repoAlias,
			AGENCY_REPOSITORY_PATH: variables.repositoryPath,
			AGENCY_CHECKOUT_PATH: variables.checkoutPath,
			AGENCY_CHECKOUT_KIND: variables.checkoutKind,
			AGENCY_REQUESTED_REF: variables.requestedRef,
			AGENCY_BASE: "",
			AGENCY_VCS: variables.vcs,
			AGENCY_WORKBASE_ROOT: variables.workbaseRoot,
			AGENCY_TASK_ID: variables.taskId,
			AGENCY_PHASE_ID: "",
		})
	})
})
