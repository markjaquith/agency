import { describe, expect, test } from "bun:test"
import {
	expandWorkspaceCreateCommand,
	workspaceCommandEnvironment,
} from "./workspace-command"

const variables = {
	repo: "/work/repos/app",
	workspace: "/work/tasks/example/code/app",
	name: "agency-example-task-app",
	revision: "0123456789abcdef",
	kind: "writable" as const,
	requestedRef: "task/example",
}

describe("workspace command templates", () => {
	test("expands argv placeholders without shell interpolation", () => {
		expect(
			expandWorkspaceCreateCommand(
				[
					"tool",
					"--repo={repo}",
					"--workspace={workspace}",
					"--name={name}",
					"--revision={revision}",
					"{kind}",
					"{requestedRef}",
				],
				variables,
			),
		).toEqual([
			"tool",
			"--repo=/work/repos/app",
			"--workspace=/work/tasks/example/code/app",
			"--name=agency-example-task-app",
			"--revision=0123456789abcdef",
			"writable",
			"task/example",
		])
	})

	test("requires creation identity placeholders", () => {
		expect(() =>
			expandWorkspaceCreateCommand(
				["tool", "{repo}", "{workspace}", "{name}"],
				variables,
			),
		).toThrow("{revision}")
	})

	test("rejects unknown placeholders", () => {
		expect(() =>
			expandWorkspaceCreateCommand(
				["tool", "{repo}", "{workspace}", "{name}", "{revision}", "{base}"],
				variables,
			),
		).toThrow("{base}")
	})

	test("provides equivalent environment variables", () => {
		expect(workspaceCommandEnvironment(variables)).toEqual({
			AGENCY_REPO: variables.repo,
			AGENCY_WORKSPACE: variables.workspace,
			AGENCY_WORKSPACE_NAME: variables.name,
			AGENCY_REVISION: variables.revision,
			AGENCY_CHECKOUT_KIND: variables.kind,
			AGENCY_REQUESTED_REF: variables.requestedRef,
		})
	})
})
