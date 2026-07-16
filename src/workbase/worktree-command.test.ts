import { describe, expect, test } from "bun:test"
import {
	expandWorktreeCreateCommand,
	worktreeCommandEnvironment,
} from "./worktree-command"

const variables = {
	repo: "/work/repos/app",
	worktree: "/work/tasks/example/code/app",
	branch: "task/example",
	base: "main",
}

describe("worktree command templates", () => {
	test("expands argv placeholders without shell interpolation", () => {
		expect(
			expandWorktreeCreateCommand(
				[
					"tool",
					"--repo={repo}",
					"--worktree",
					"{worktree}",
					"{branch}",
					"{base}",
				],
				variables,
			),
		).toEqual([
			"tool",
			"--repo=/work/repos/app",
			"--worktree",
			"/work/tasks/example/code/app",
			"task/example",
			"main",
		])
	})

	test("requires repo and worktree placeholders", () => {
		expect(() =>
			expandWorktreeCreateCommand(["tool", "{repo}"], variables),
		).toThrow("{worktree}")
	})

	test("rejects unknown placeholders", () => {
		expect(() =>
			expandWorktreeCreateCommand(
				["tool", "{repo}", "{worktree}", "{unknown}"],
				variables,
			),
		).toThrow("{unknown}")
	})

	test("provides equivalent environment variables", () => {
		expect(worktreeCommandEnvironment(variables)).toEqual({
			AGENCY_REPO: variables.repo,
			AGENCY_WORKTREE: variables.worktree,
			AGENCY_BRANCH: variables.branch,
			AGENCY_BASE: variables.base,
		})
	})
})
