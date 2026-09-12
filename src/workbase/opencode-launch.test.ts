import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { FileSystemService } from "../services/FileSystemService"
import { prepareOpenCodeLaunch } from "./opencode-launch"

const cwd = "/workbase/tasks/smoke"
const session = { id: "ses_smoke", location: { directory: cwd } }
const harness = (
	options: {
		version?: string
		resume?: boolean
		existing?: boolean
		fail?: boolean
		wrongDirectory?: boolean
		extra?: string[]
		alias?: boolean
		failEnvironment?: boolean
	} = {},
) => {
	const calls: (readonly string[])[] = []
	const fs = Layer.succeed(FileSystemService, {
		realPath: (path: string) => Effect.succeed(path === "/alias" ? cwd : path),
		runCommand: (
			argv: readonly string[],
			settings: { cwd: string; env: Record<string, string> },
		) => {
			expect(settings.cwd).toBe(cwd)
			expect(settings.env.AGENCY_PROMPT).toBe("generated prompt")
			calls.push(argv)
			if (argv[2] === "--server") argv = [argv[0]!, argv[1]!, ...argv.slice(4)]
			let output: unknown
			if (argv[1] === "--version")
				return Effect.succeed({
					exitCode: 0,
					stdout: options.version ?? "opencode v2.0.1",
					stderr: "",
				})
			if (argv[2] === "get") {
				if (argv[3]?.includes("?")) {
					expect(argv[3]).toContain("directory=%2Fworkbase%2Ftasks%2Fsmoke")
					expect(argv[3]).toContain("parentID=null")
					output = { data: options.existing ? [session] : [] }
				} else output = { data: session }
			} else if (argv[3] === "/api/session") {
				output = {
					data: options.wrongDirectory
						? { ...session, location: { directory: "/elsewhere" } }
						: session,
				}
			} else if (argv[2] === "put") {
				expect(JSON.parse(argv[5]!).variables.AGENCY_PROMPT).toBe(
					"generated prompt",
				)
				if (options.failEnvironment)
					return Effect.succeed({
						exitCode: 1,
						stdout: "",
						stderr: "environment failed",
					})
				return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" })
			} else if (argv[3]?.endsWith("/model") || argv[3]?.endsWith("/agent")) {
				return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" })
			} else {
				const body = JSON.parse(argv[5]!)
				expect(body.text).toBe("generated prompt")
				expect(body.resume).toBe(true)
				if (options.fail)
					return Effect.succeed({
						exitCode: 1,
						stdout: "",
						stderr: "admission failed",
					})
				output = { data: { id: body.id, sessionID: session.id, type: "user" } }
			}
			return Effect.succeed({
				exitCode: 0,
				stdout: JSON.stringify(output),
				stderr: "",
			})
		},
	} as unknown as FileSystemService)
	return {
		calls,
		run: () =>
			Effect.runPromise(
				prepareOpenCodeLaunch(
					[
						"opencode",
						...(options.resume ? ["--continue"] : []),
						"--prompt",
						"generated prompt",
						...(options.extra ?? []),
					],
					options.alias ? "/alias" : cwd,
					{ AGENCY_PROMPT: "generated prompt" },
				).pipe(Effect.provide(fs)),
			),
	}
}

describe("OpenCode auto-start", () => {
	test("submits once and attaches without a composer prompt", async () => {
		const h = harness()
		expect(await h.run()).toEqual(["opencode", "--session", session.id])
		expect(h.calls.filter((call) => call[3]?.endsWith("/prompt"))).toHaveLength(
			1,
		)
		expect(h.calls.findIndex((call) => call[2] === "put")).toBeLessThan(
			h.calls.findIndex((call) => call[3]?.endsWith("/prompt")),
		)
	})
	test("canonicalizes the launch directory before API calls", async () => {
		const h = harness({ alias: true })
		await h.run()
		const create = h.calls.find((call) => call[3] === "/api/session")!
		expect(JSON.parse(create[5]!).location.directory).toBe(cwd)
	})
	test("preserves explicit session, server, model, agent, and TUI options", async () => {
		const h = harness({
			extra: [
				"--session",
				session.id,
				"--server",
				"http://localhost:9876",
				"--model",
				"provider/model#high",
				"--agent",
				"plan",
				"--auto",
				"--log-level",
				"debug",
			],
		})
		expect(await h.run()).toEqual([
			"opencode",
			"--server",
			"http://localhost:9876",
			"--auto",
			"--log-level",
			"debug",
			"--session",
			session.id,
		])
		const api = h.calls.filter((call) => call[1] === "api")
		expect(
			api.every(
				(call) => call[2] === "--server" && call[3] === "http://localhost:9876",
			),
		).toBe(true)
		expect(
			JSON.parse(api.find((call) => call[5]?.endsWith("/agent"))![7]!),
		).toEqual({ agent: "plan" })
		expect(
			JSON.parse(api.find((call) => call[5]?.endsWith("/model"))![7]!),
		).toEqual({
			model: { providerID: "provider", id: "model", variant: "high" },
		})
		expect(
			api.some((call) => call[4] === "post" && call[5] === "/api/session"),
		).toBe(false)
	})
	test("does not admit a prompt when setting session environment fails", async () => {
		const h = harness({ failEnvironment: true })
		await expect(h.run()).rejects.toThrow("environment failed")
		expect(h.calls.some((call) => call[3]?.endsWith("/prompt"))).toBe(false)
	})
	test("rejects unsupported private-service launches before creating a session", async () => {
		const h = harness({ extra: ["--standalone"] })
		await expect(h.run()).rejects.toThrow("--standalone")
		expect(h.calls).toHaveLength(1)
	})
	test("continues the newest root session in the exact launch directory", async () => {
		const h = harness({ resume: true, existing: true })
		expect(await h.run()).toEqual(["opencode", "--session", session.id])
		expect(
			h.calls.some((call) => call[2] === "post" && call[3] === "/api/session"),
		).toBe(false)
	})
	test("creates a session when continue has no history", async () => {
		const h = harness({ resume: true })
		await h.run()
		expect(
			h.calls.some((call) => call[2] === "post" && call[3] === "/api/session"),
		).toBe(true)
	})
	test("preserves V1 native launch", async () => {
		const h = harness({ version: "1.18.29" })
		expect(await h.run()).toEqual(["opencode", "--prompt", "generated prompt"])
		expect(h.calls).toHaveLength(1)
	})
	test("fails instead of opening an unsubmitted composer or retrying admission", async () => {
		const h = harness({ fail: true })
		await expect(h.run()).rejects.toThrow("admission failed")
		expect(h.calls.filter((call) => call[3]?.endsWith("/prompt"))).toHaveLength(
			1,
		)
	})
	test("rejects a session from a different directory before submission", async () => {
		const h = harness({ wrongDirectory: true })
		await expect(h.run()).rejects.toThrow("outside the launch directory")
		expect(h.calls.some((call) => call[3]?.endsWith("/prompt"))).toBe(false)
	})
	test("fails closed on unknown CLI versions", async () => {
		const h = harness({ version: "unexpected" })
		await expect(h.run()).rejects.toThrow("Unsupported OpenCode version")
		expect(h.calls).toHaveLength(1)
	})
})
