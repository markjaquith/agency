import { describe, expect, test } from "bun:test"
import {
	printableEnvironment,
	resolveAgentCommand,
	agentEnvironment,
	validateAgents,
} from "./agent-command"

const variables = {
	prompt: "Read the task.",
	workbase: "/workbase",
	target: "execution-unit:phase/task/build",
	task: "task",
	phase: "build",
	sessionId: "session-1",
}

describe("agent commands", () => {
	test("uses promptless interactive commands for built-in presets", () => {
		expect(
			resolveAgentCommand("opencode2", undefined, variables, false).argv,
		).toEqual(["opencode2"])
		expect(
			resolveAgentCommand("opencode2", undefined, variables, true).argv,
		).toEqual(["opencode2", "--continue"])
		expect(
			resolveAgentCommand("opencode", undefined, variables, false).argv,
		).toEqual(["opencode"])
		expect(
			resolveAgentCommand("opencode", undefined, variables, true).argv,
		).toEqual(["opencode", "--continue"])
		expect(resolveAgentCommand("pi", undefined, variables, false).argv).toEqual(
			["pi"],
		)
		expect(resolveAgentCommand("pi", undefined, variables, true).argv).toEqual([
			"pi",
			"--continue",
		])
		expect(
			resolveAgentCommand("claude", undefined, variables, true).argv,
		).toEqual(["claude", "--continue"])
	})

	test("uses autonomous commands when a prompt is requested", () => {
		expect(
			resolveAgentCommand("opencode2", undefined, variables, false, true).argv,
		).toEqual(["opencode2", "--prompt", "Read the task."])
		expect(
			resolveAgentCommand("opencode2", undefined, variables, true, true).argv,
		).toEqual(["opencode2", "--continue", "--prompt", "Read the task."])
		expect(
			resolveAgentCommand("opencode", undefined, variables, false, true).argv,
		).toEqual(["opencode", "--prompt", "Read the task."])
		expect(
			resolveAgentCommand("opencode", undefined, variables, true, true).argv,
		).toEqual(["opencode", "--continue", "--prompt", "Read the task."])
		expect(
			resolveAgentCommand("pi", undefined, variables, false, true).argv,
		).toEqual(["pi", "Read the task."])
		expect(
			resolveAgentCommand("claude", undefined, variables, true, true).argv,
		).toEqual(["claude", "--continue", "Read the task."])
	})

	test("expands configured argv and environment without a shell", () => {
		const resolved = resolveAgentCommand(
			"custom",
			{
				custom: {
					command: ["agent"],
					autoCommand: ["agent", "--target={target}", "{prompt}"],
					environment: { CUSTOM_SESSION: "{sessionId}" },
				},
			},
			variables,
			false,
			true,
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

	test("rejects --auto for configured agents without an auto command", () => {
		expect(() =>
			resolveAgentCommand(
				"custom",
				{ custom: { command: ["agent"] } },
				variables,
				false,
				true,
			),
		).toThrow("Agent 'custom' does not support --auto")
	})

	test("rejects unknown placeholders", () => {
		expect(() =>
			validateAgents({ custom: { command: ["agent", "{unknown}"] } }),
		).toThrow("Unknown agent 'custom' placeholder: {unknown}")
	})

	test("provides normalized Agency environment and filters secret values", () => {
		const environment = {
			...agentEnvironment("custom", variables),
			VISIBLE: "yes",
			ACCESS_TOKEN: "secret",
		}

		expect(environment).toMatchObject({
			AGENCY_AGENT: "custom",
			AGENCY_INVOCATION_SOURCE: "agent",
			AGENCY_SESSION_ID: "session-1",
			AGENCY_WORKBASE: "/workbase",
			AGENCY_TARGET: "execution-unit:phase/task/build",
			AGENCY_TASK_ID: "task",
			AGENCY_PHASE_ID: "build",
			AGENCY_PROMPT: "Read the task.",
		})
		expect(printableEnvironment(environment).VISIBLE).toBe("yes")
		expect(printableEnvironment(environment).ACCESS_TOKEN).toBeUndefined()
	})
})
