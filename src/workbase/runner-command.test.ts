import { describe, expect, test } from "bun:test"
import {
	printableEnvironment,
	resolveRunnerCommand,
	runnerEnvironment,
	validateRunners,
} from "./runner-command"

const variables = {
	prompt: "Read the task.",
	workbase: "/workbase",
	target: "execution-unit:phase/task/build",
	task: "task",
	phase: "build",
	claimant: "orchestrator",
	sessionId: "session-1",
	claimRevision: "revision-1",
}

describe("runner commands", () => {
	test("uses deterministic fresh and resume commands for built-in presets", () => {
		expect(
			resolveRunnerCommand("opencode", undefined, variables, false).argv,
		).toEqual(["opencode", "--prompt", "Read the task."])
		expect(
			resolveRunnerCommand("opencode", undefined, variables, true).argv,
		).toEqual(["opencode", "--continue", "--prompt", "Read the task."])
		expect(
			resolveRunnerCommand("claude", undefined, variables, true).argv,
		).toEqual(["claude", "--continue", "Read the task."])
	})

	test("expands configured argv and environment without a shell", () => {
		const resolved = resolveRunnerCommand(
			"custom",
			{
				custom: {
					command: ["agent", "--target={target}", "{prompt}"],
					environment: { CUSTOM_SESSION: "{sessionId}" },
				},
			},
			variables,
			false,
		)

		expect(resolved).toEqual({
			argv: [
				"agent",
				"--target=execution-unit:phase/task/build",
				"Read the task.",
			],
			environment: { CUSTOM_SESSION: "session-1" },
		})
	})

	test("rejects unknown placeholders", () => {
		expect(() =>
			validateRunners({ custom: { command: ["agent", "{unknown}"] } }),
		).toThrow("Unknown runner 'custom' placeholder: {unknown}")
	})

	test("provides normalized Agency environment and filters secret values", () => {
		const environment = {
			...runnerEnvironment("custom", variables),
			VISIBLE: "yes",
			ACCESS_TOKEN: "secret",
		}

		expect(environment).toMatchObject({
			AGENCY_RUNNER: "custom",
			AGENCY_CLAIMANT: "orchestrator",
			AGENCY_TARGET: "execution-unit:phase/task/build",
			AGENCY_TASK_ID: "task",
			AGENCY_PHASE_ID: "build",
		})
		expect(printableEnvironment(environment).VISIBLE).toBe("yes")
		expect(printableEnvironment(environment).ACCESS_TOKEN).toBeUndefined()
	})
})
