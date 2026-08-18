import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { cleanupTempDir, createTempDir } from "../src/test-utils"
import agencyExtension from "./agency"

describe("global Pi extension", () => {
	let root: string

	beforeEach(async () => {
		root = await createTempDir()
	})

	afterEach(async () => cleanupTempDir(root))

	const load = (response?: object) => {
		const handlers = new Map<string, (...args: any[]) => any>()
		const pi = {
			exec: async () => ({
				code: response ? 0 : 1,
				stdout: response ? JSON.stringify(response) : "",
				stderr: "",
			}),
			on: (name: string, handler: (...args: any[]) => any) => {
				handlers.set(name, handler)
			},
		}
		agencyExtension(pi as never)
		return handlers
	}

	test("no-ops outside Agency workbases without invoking the CLI", async () => {
		let executions = 0
		const handlers = new Map<string, (...args: any[]) => any>()
		agencyExtension({
			exec: async () => {
				executions += 1
				return { code: 1, stdout: "", stderr: "" }
			},
			on: (name: string, handler: (...args: any[]) => any) => {
				handlers.set(name, handler)
			},
		} as never)

		expect(
			await handlers.get("resources_discover")?.({ cwd: root }),
		).toBeUndefined()
		expect(
			await handlers.get("before_agent_start")?.(
				{ systemPrompt: "Base" },
				{ cwd: root },
			),
		).toBeUndefined()
		expect(executions).toBe(0)
	})

	test("uses CLI context from nested directories for skills and authority", async () => {
		const task = join(root, "tasks", "example")
		const nested = join(task, "code", "agency", "src")
		const checkout = join(task, "code", "agency")
		await Bun.write(join(root, "agency.json"), '{"version":2}\n')
		await mkdir(join(root, ".agency"), { recursive: true })
		await Bun.write(
			join(root, ".agency", "AGENTS.md"),
			"# Managed instructions\n",
		)
		await mkdir(join(checkout, ".agents", "skills"), { recursive: true })
		await mkdir(nested, { recursive: true })

		const handlers = load({
			ok: true,
			result: {
				workbase: { root },
				target: {
					kind: "task",
					taskId: "example",
					path: join(task, "TASK.md"),
				},
				authority: { mode: "execution", writable: { checkoutPath: checkout } },
				documents: { task: { data: { status: "working" } } },
				validation: { valid: true },
			},
		})
		const resources = await handlers.get("resources_discover")?.({
			cwd: nested,
		})
		expect(resources.skillPaths).toEqual([join(checkout, ".agents", "skills")])

		const prompt = await handlers.get("before_agent_start")?.(
			{ systemPrompt: "Base" },
			{ cwd: nested },
		)
		expect(prompt.systemPrompt).toContain("# Managed instructions")
		expect(prompt.systemPrompt).toContain(
			`${checkout} as the default implementation directory`,
		)
	})

	test("rejects CLI context for a different workbase", async () => {
		await Bun.write(join(root, "agency.json"), '{"version":2}\n')
		const handlers = load({
			ok: true,
			result: {
				workbase: { root: join(root, "other") },
				target: { kind: "epic", epicId: "example" },
				validation: { valid: true },
			},
		})

		expect(
			await handlers.get("before_agent_start")?.(
				{ systemPrompt: "Base" },
				{ cwd: root },
			),
		).toBeUndefined()
	})
})
