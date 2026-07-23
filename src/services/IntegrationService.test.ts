import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { createHash } from "node:crypto"
import { mkdir, stat, symlink, unlink, utimes } from "node:fs/promises"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { cleanupTempDir, createTempDir, runTestEffect } from "../test-utils"
import { managedWorkbaseAgents } from "../workbase/agents-file"
import { managedWorkbaseOpencode } from "../workbase/opencode-file"
import {
	canUpdateManagedWorkbaseOpencodePlugin,
	managedWorkbaseOpencodePlugin,
} from "../workbase/opencode-plugin-file"
import { managedWorkbaseOpencodeTui } from "../workbase/opencode-tui-file"
import {
	canUpdateManagedWorkbaseOpencodeTuiPlugin,
	managedWorkbaseOpencodeTuiPlugin,
} from "../workbase/opencode-tui-plugin-file"
import { IntegrationService } from "./IntegrationService"

const write = async (root: string, path: string, content: string) => {
	const fullPath = join(root, path)
	await mkdir(dirname(fullPath), { recursive: true })
	await Bun.write(fullPath, content)
}

const managed = (prefix: string, body: string, suffix = "") => {
	const checksum = createHash("sha256").update(body).digest("hex")
	return `${prefix}${checksum}${suffix}\n\n${body}`
}

const managedBody = (content: string) =>
	content.slice(content.indexOf("\n\n") + 2)

const legacyCommand = (content: string) =>
	content.replace(
		/^---\n/,
		`---\n# agency-managed: sha256=${createHash("sha256").update(content).digest("hex")}\n`,
	)

const status = (root: string) =>
	runTestEffect(
		IntegrationService.pipe(Effect.flatMap((service) => service.status(root))),
	)

const sync = (root: string) =>
	runTestEffect(
		IntegrationService.pipe(Effect.flatMap((service) => service.sync(root))),
	)

describe("IntegrationService", () => {
	let root: string

	beforeEach(async () => {
		root = await createTempDir()
		await write(root, "agency.json", '{"version":2}\n')
	})

	afterEach(async () => cleanupTempDir(root))

	test("reports missing and current managed files without writing", async () => {
		expect((await status(root)).files.map(({ state }) => state)).toEqual([
			"missing",
			"missing",
			"missing",
			"missing",
			"missing",
		])
		expect(await Bun.file(join(root, ".agency/AGENTS.md")).exists()).toBe(false)

		await write(root, ".agency/AGENTS.md", managedWorkbaseAgents)
		await write(root, ".opencode/opencode.jsonc", managedWorkbaseOpencode)
		await write(
			root,
			".opencode/plugin/agency-repository-skills.ts",
			managedWorkbaseOpencodePlugin,
		)
		await write(root, ".opencode/tui.jsonc", managedWorkbaseOpencodeTui)
		await write(
			root,
			".opencode/tui/agency-debug.ts",
			managedWorkbaseOpencodeTuiPlugin,
		)
		expect((await status(root)).files.map(({ state }) => state)).toEqual([
			"managed",
			"managed",
			"managed",
			"managed",
			"managed",
		])
	})

	test("reports customized and checksum-safe drifted files", async () => {
		await write(root, ".agency/AGENTS.md", "# Custom instructions\n")
		await write(
			root,
			".opencode/opencode.jsonc",
			managed("// agency-managed: sha256=", '{"references":{}}\n'),
		)

		expect((await status(root)).files.map(({ state }) => state)).toEqual([
			"customized",
			"drifted",
			"missing",
			"missing",
			"missing",
		])
	})

	test("generates a dynamic workbase plugin", () => {
		expect(managedWorkbaseOpencodePlugin).toContain(
			"process.env.AGENCY_WRITABLE_CHECKOUT",
		)
		expect(managedWorkbaseOpencodePlugin).toContain(
			'["agency", "context", ".", "--compact", "--json"]',
		)
		expect(managedWorkbaseOpencodePlugin).toContain(
			'join(checkout, ".claude", "skills")',
		)
		expect(managedWorkbaseOpencodePlugin).toContain(
			'join(checkout, ".agents", "skills")',
		)
		expect(managedWorkbaseOpencodePlugin).toContain(
			'join(checkout, ".opencode", "skills")',
		)
		expect(managedWorkbaseOpencodePlugin).toContain(
			'config.permission.external_directory = { [join(root, "*")]: "allow" }',
		)
		expect(managedWorkbaseOpencodePlugin).toContain(
			"config.skills.paths = [...new Set",
		)
		expect(managedWorkbaseOpencodePlugin).toContain(
			".map((path) => `${path}${sep}.`)",
		)
		expect(
			canUpdateManagedWorkbaseOpencodePlugin(managedWorkbaseOpencodePlugin),
		).toBe(true)
		expect(
			canUpdateManagedWorkbaseOpencodePlugin(
				managedWorkbaseOpencodePlugin.replace("config.skills ??= {}", ""),
			),
		).toBe(false)
	})

	test("registers a TUI-only /agency-debug diagnostic", async () => {
		const config = JSON.parse(managedBody(managedWorkbaseOpencodeTui))
		expect(config).toEqual({
			$schema: "https://opencode.ai/tui.json",
			plugin: ["./tui/agency-debug.ts"],
		})

		const path = join(root, ".opencode/tui/agency-debug.ts")
		await write(
			root,
			".opencode/tui/agency-debug.ts",
			managedWorkbaseOpencodeTuiPlugin,
		)
		const module = await import(pathToFileURL(path).href)
		let clientReads = 0

		const runDiagnostic = async (
			paths: string[],
			options: {
				ready?: boolean
				managedReference?: boolean
				externalDirectory?: Record<string, string>
			} = {},
		) => {
			let command:
				| {
						slashName?: string
						namespace?: string
						run: () => void
				  }
				| undefined
			let toast: { variant: string; message: string } | undefined
			await module.default.tui({
				get client() {
					clientReads += 1
					throw new Error("diagnostic must not access the server client")
				},
				state: {
					ready: options.ready ?? true,
					config: {
						skills: { paths },
						references: options.managedReference
							? {
									workbase: {
										path: "..",
										description:
											"Complete Agency workbase context; write authority still comes only from agency context",
									},
								}
							: undefined,
						permission: options.externalDirectory
							? { external_directory: options.externalDirectory }
							: undefined,
					},
					path: { directory: join(root, "tasks", "example") },
				},
				keymap: {
					registerLayer: (layer: { commands: (typeof command)[] }) => {
						command = layer.commands[0]
					},
				},
				ui: {
					toast: (input: { variant: string; message: string }) => {
						toast = input
					},
				},
			} as never)
			expect(command).toMatchObject({
				namespace: "palette",
				slashName: "agency-debug",
			})
			command?.run()
			return toast
		}

		expect(await runDiagnostic(["/checkout/.agents/skills/."])).toMatchObject({
			variant: "success",
			message: expect.stringContaining("Server plugin: initialized"),
		})
		expect(
			await runDiagnostic([], {
				managedReference: true,
				externalDirectory: { [join(root, "*")]: "allow" },
			}),
		).toMatchObject({
			variant: "success",
			message: expect.stringContaining("workbase access registered"),
		})
		expect(
			await runDiagnostic([], {
				externalDirectory: { [join(root, "*")]: "allow" },
			}),
		).toMatchObject({
			variant: "warning",
			message: expect.stringContaining("Server plugin: indeterminate"),
		})
		expect(await runDiagnostic([])).toMatchObject({
			variant: "warning",
			message: expect.stringContaining("Server plugin: indeterminate"),
		})
		expect(clientReads).toBe(0)
		expect(managedWorkbaseOpencodeTuiPlugin).not.toContain("chat.message")
		expect(
			canUpdateManagedWorkbaseOpencodeTuiPlugin(
				managedWorkbaseOpencodeTuiPlugin,
			),
		).toBe(true)
	})

	test("generates context-first safety and execution closeout guidance", () => {
		const body = managedBody(managedWorkbaseAgents)

		expect(body).toContain("agency context . --json")
		expect(body).toContain("authority.writable.checkoutPath")
		expect(body).toContain("`agency work` is the local launch flow")
		expect(body).toContain("External orchestrators claim before launching")
		expect(body).toContain("Run `agency validate`")
		expect(body).toContain("only with explicit user intent")
		expect(body).toContain("An execution unit remains `working`")
		expect(body).toContain("It becomes `done`")
		expect(body).toContain("Do not mark committed")
		expect(body).toContain("creating or updating a PR")
		expect(body).toContain("marking it ready")
		expect(body).toMatch(/completing\s+a refinement loop/)
		expect(body).toContain("pausing or handing off")
		expect(body).toContain("`agency finish`")
		expect(body).toContain("`agency sync --apply`")
		expect(body).toContain("`TASK.md` or `PHASE.md`")
		expect(body).toContain("PR state, current head, diff summary")
		expect(body).toContain("Run `agency validate` before reporting completion")
		expect(body).toContain("agency integration status")
		expect(body).not.toContain(".opencode/command/agency.md")
	})

	test("configures Agency agents with complete workbase access", () => {
		const config = JSON.parse(managedBody(managedWorkbaseOpencode))

		expect(config.instructions).toEqual([".agency/AGENTS.md"])
		expect(config.agent).toEqual({
			agency: {
				description:
					"Handles Agency workbase orchestration and workflow operations with the Agency CLI",
				mode: "subagent",
				prompt: expect.stringContaining("agency context . --json"),
			},
			plan: {
				disable: true,
			},
			"agency-plan": {
				description:
					"Agency planning mode. May update Agency plans and planning structure.",
				mode: "primary",
				prompt: expect.stringContaining("You are in Agency Plan mode"),
				permission: {
					question: "allow",
					bash: {
						"agency *": "allow",
					},
					edit: {
						"*": "deny",
						"tasks/*/TASK.md": "allow",
						"tasks/*/phases/*/PHASE.md": "allow",
						"epics/*/EPIC.md": "allow",
					},
				},
			},
		})
		expect(config.agent.agency.model).toBeUndefined()
		expect(config.agent.agency.permission).toBeUndefined()
		expect(config.agent.agency.hidden).toBeUndefined()
		expect(config.agent.agency.steps).toBeUndefined()
		expect(config.agent.agency.prompt).toContain(
			"verify that the runner started successfully",
		)
		expect(config.agent.agency.prompt).toContain(
			"return without waiting for the task to finish",
		)
		expect(config.agent["agency-plan"].prompt).toContain(
			"Start with `agency context . --json`",
		)
		expect(config.agent["agency-plan"].prompt).toContain(
			"decompose it into independently deliverable tasks",
		)
		expect(config.agent["agency-plan"].prompt).toContain("Use `--if-revision`")
		expect(config.agent["agency-plan"].prompt).toContain(
			"available ticket tools",
		)
		expect(config.agent["agency-plan"].prompt).toContain(
			"changing lifecycle state",
		)
		expect(config.agent["agency-plan"].prompt).toContain(
			"Follow the managed Agency instructions and reported authority",
		)
		expect(config.agent["agency-plan"].permission.bash["*"]).toBeUndefined()
		expect(config.references).toEqual({
			workbase: {
				path: "..",
				description:
					"Complete Agency workbase context; write authority still comes only from agency context",
			},
		})
		expect(config.permission).toBeUndefined()
		expect(managedBody(managedWorkbaseOpencode)).not.toContain(process.cwd())
	})

	test("treats an existing JSON OpenCode config as customized", async () => {
		await write(root, ".opencode/opencode.json", '{"model":"test/model"}\n')

		const result = await status(root)
		expect(result.files[1]).toMatchObject({
			name: "opencode",
			path: join(root, ".opencode/opencode.json"),
			state: "customized",
			diagnostic: expect.stringContaining("cannot guarantee"),
			remediation: expect.stringContaining("global config"),
		})
	})

	test("treats a JSON config beside managed JSONC as customized", async () => {
		await write(root, ".opencode/opencode.jsonc", managedWorkbaseOpencode)
		await write(root, ".opencode/opencode.json", '{"model":"test/model"}\n')

		const result = await status(root)
		expect(result.files[1]).toMatchObject({
			name: "opencode",
			path: join(root, ".opencode/opencode.json"),
			state: "customized",
		})
	})

	test("reports actionable whole-workbase access diagnostics", async () => {
		let result = await status(root)
		expect(result.files[1]).toMatchObject({
			state: "missing",
			diagnostic: expect.stringContaining("cannot load"),
			remediation: expect.stringContaining("integration sync"),
		})

		await write(root, ".opencode/opencode.jsonc", '{"model":"test/model"}\n')
		result = await status(root)
		expect(result.files[1]).toMatchObject({
			state: "customized",
			diagnostic: expect.stringContaining("cannot guarantee"),
			remediation: expect.stringContaining("global config"),
		})
	})

	test("syncs missing and drifted files while preserving customized files", async () => {
		const customRootAgents = "# User-owned workbase instructions\n"
		const customManagedAgents = "# Customized Agency instructions\n"
		await write(root, "AGENTS.md", customRootAgents)
		await write(root, ".agency/AGENTS.md", customManagedAgents)
		await write(
			root,
			".opencode/opencode.jsonc",
			managed("// agency-managed: sha256=", '{"references":{}}\n'),
		)

		const first = await sync(root)
		expect(first.files).toMatchObject([
			{ name: "agents", state: "customized", changed: false },
			{ name: "opencode", state: "managed", changed: true },
			{ name: "opencode-plugin", state: "managed", changed: true },
			{ name: "opencode-tui", state: "managed", changed: true },
			{ name: "opencode-tui-plugin", state: "managed", changed: true },
		])
		expect(await Bun.file(join(root, "AGENTS.md")).text()).toBe(
			customRootAgents,
		)
		expect(await Bun.file(join(root, ".agency/AGENTS.md")).text()).toBe(
			customManagedAgents,
		)
		expect(await Bun.file(join(root, ".opencode/opencode.jsonc")).text()).toBe(
			managedWorkbaseOpencode,
		)
		expect(
			await Bun.file(join(root, ".opencode/command/agency.md")).exists(),
		).toBe(false)
		expect(
			await Bun.file(
				join(root, ".opencode/plugin/agency-repository-skills.ts"),
			).text(),
		).toBe(managedWorkbaseOpencodePlugin)
		expect(await Bun.file(join(root, ".opencode/tui.jsonc")).text()).toBe(
			managedWorkbaseOpencodeTui,
		)
		expect(
			await Bun.file(join(root, ".opencode/tui/agency-debug.ts")).text(),
		).toBe(managedWorkbaseOpencodeTuiPlugin)

		await unlink(join(root, ".agency/AGENTS.md"))
		const second = await sync(root)
		expect(second.files[0]).toMatchObject({ state: "managed", changed: true })
		expect(await Bun.file(join(root, ".agency/AGENTS.md")).text()).toBe(
			managedWorkbaseAgents,
		)
		expect(await Bun.file(join(root, "AGENTS.md")).text()).toBe(
			customRootAgents,
		)
	})

	test("preserves user-owned checkout-skill plugins at either supported path", async () => {
		const custom = "export default async () => ({})\n"
		await write(root, ".opencode/plugins/agency-repository-skills.ts", custom)

		let result = await sync(root)
		expect(result.files[2]).toMatchObject({
			name: "opencode-plugin",
			path: join(root, ".opencode/plugins/agency-repository-skills.ts"),
			state: "customized",
			changed: false,
		})
		expect(
			await Bun.file(
				join(root, ".opencode/plugin/agency-repository-skills.ts"),
			).exists(),
		).toBe(false)

		await unlink(join(root, ".opencode/plugins/agency-repository-skills.ts"))
		await write(root, ".opencode/plugin/agency-repository-skills.ts", custom)
		result = await sync(root)
		expect(result.files[2]).toMatchObject({
			path: join(root, ".opencode/plugin/agency-repository-skills.ts"),
			state: "customized",
			changed: false,
		})
	})

	test("preserves user-owned TUI config and diagnostic plugin", async () => {
		const customConfig = '{"theme":"custom"}\n'
		const customPlugin =
			"export default { id: 'agency.debug', tui: async () => {} }\n"
		await write(root, ".opencode/tui.json", customConfig)
		await write(root, ".opencode/tui/agency-debug.ts", customPlugin)

		const result = await sync(root)
		expect(result.files[3]).toMatchObject({
			name: "opencode-tui",
			path: join(root, ".opencode/tui.json"),
			state: "customized",
			changed: false,
			remediation: expect.stringContaining("plugin list"),
		})
		expect(result.files[4]).toMatchObject({
			name: "opencode-tui-plugin",
			state: "customized",
			changed: false,
		})
		expect(await Bun.file(join(root, ".opencode/tui.json")).text()).toBe(
			customConfig,
		)
		expect(
			await Bun.file(join(root, ".opencode/tui/agency-debug.ts")).text(),
		).toBe(customPlugin)
	})

	test("removes a checksum-valid legacy command and preserves a customized file", async () => {
		const path = ".opencode/command/agency.md"
		const legacy = legacyCommand(
			"---\ndescription: Operate Agency work\n---\n\nLegacy command.\n",
		)
		await write(root, path, legacy)

		await status(root)
		expect(await Bun.file(join(root, path)).text()).toBe(legacy)

		await sync(root)
		expect(await Bun.file(join(root, path)).exists()).toBe(false)

		const custom = `${legacy}User edit.\n`
		await write(root, path, custom)
		await sync(root)
		expect(await Bun.file(join(root, path)).text()).toBe(custom)
	})

	test("migrates checksum-valid root instructions", async () => {
		await write(root, "AGENTS.md", managedWorkbaseAgents)

		const result = await sync(root)

		expect(result.files[0]).toMatchObject({ state: "managed", changed: true })
		expect(await Bun.file(join(root, ".agency/AGENTS.md")).text()).toBe(
			managedWorkbaseAgents,
		)
		expect(await Bun.file(join(root, "AGENTS.md")).exists()).toBe(false)
	})

	test("preserves legacy instructions when the OpenCode config is customized", async () => {
		await write(root, "AGENTS.md", managedWorkbaseAgents)
		await write(root, ".opencode/opencode.json", '{"model":"test/model"}\n')

		const result = await sync(root)

		expect(result.files[0]).toMatchObject({ state: "managed", changed: true })
		expect(result.files[1]).toMatchObject({
			state: "customized",
			changed: false,
		})
		expect(await Bun.file(join(root, "AGENTS.md")).text()).toBe(
			managedWorkbaseAgents,
		)
	})

	test("does not rewrite an already-current OpenCode configuration", async () => {
		const path = join(root, ".opencode/opencode.jsonc")
		await write(root, ".opencode/opencode.jsonc", managedWorkbaseOpencode)
		const timestamp = new Date("2000-01-01T00:00:00.000Z")
		await utimes(path, timestamp, timestamp)

		const result = await sync(root)

		expect(result.files[1]).toMatchObject({
			state: "managed",
			changed: false,
		})
		expect((await stat(path)).mtimeMs).toBe(timestamp.getTime())
	})

	test("does not overwrite managed files whose checksums no longer match", async () => {
		const tampered = `${managed(
			"<!-- agency-managed: sha256=",
			"# Previous Agency instructions\n",
			" -->",
		)}User edit\n`
		await write(root, ".agency/AGENTS.md", tampered)

		const result = await sync(root)
		expect(result.files[0]).toMatchObject({
			state: "customized",
			changed: false,
		})
		expect(await Bun.file(join(root, ".agency/AGENTS.md")).text()).toBe(
			tampered,
		)
	})

	test("does not overwrite a user-modified OpenCode configuration", async () => {
		const tampered = `${managed(
			"// agency-managed: sha256=",
			'{"references":{}}\n',
		)}// User edit\n`
		await write(root, ".opencode/opencode.jsonc", tampered)

		const result = await sync(root)
		expect(result.files[1]).toMatchObject({
			state: "customized",
			changed: false,
		})
		expect(await Bun.file(join(root, ".opencode/opencode.jsonc")).text()).toBe(
			tampered,
		)
	})

	test("does not follow symlinked integration files", async () => {
		const target = join(root, "custom-agents.md")
		await Bun.write(target, "# External instructions\n")
		await mkdir(join(root, ".agency"), { recursive: true })
		await symlink(target, join(root, ".agency/AGENTS.md"))

		const result = await sync(root)
		expect(result.files[0]).toMatchObject({
			state: "customized",
			changed: false,
		})
		expect(await Bun.file(target).text()).toBe("# External instructions\n")
	})
})
