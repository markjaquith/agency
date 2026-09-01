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
import { FileSystemService } from "./FileSystemService"

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
			".opencode/plugins/agency-repository-skills.ts",
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

	test("inspects each integration path once per status call", async () => {
		const service = await Effect.runPromise(
			Effect.provide(FileSystemService, FileSystemService.Default),
		)
		const inspected = new Map<string, number>()
		const instrumented = {
			...service,
			inspectFile: (path: string) => {
				inspected.set(path, (inspected.get(path) ?? 0) + 1)
				return service.inspectFile(path)
			},
		}

		await runTestEffect(
			IntegrationService.pipe(
				Effect.flatMap((integration) => integration.statusRoot(root)),
				Effect.provideService(FileSystemService, instrumented),
			),
		)

		expect(inspected.size).toBe(8)
		expect([...inspected.values()]).toEqual(Array(8).fill(1))
	})

	test("inspects integration and legacy paths once per synchronized call", async () => {
		const service = await Effect.runPromise(
			Effect.provide(FileSystemService, FileSystemService.Default),
		)
		const inspected = new Map<string, number>()
		const instrumented = {
			...service,
			inspectFile: (path: string) => {
				inspected.set(path, (inspected.get(path) ?? 0) + 1)
				return service.inspectFile(path)
			},
		}

		await runTestEffect(
			IntegrationService.pipe(
				Effect.flatMap((integration) => integration.syncRoot(root)),
				Effect.provideService(FileSystemService, instrumented),
			),
		)

		expect(inspected.size).toBe(11)
		expect([...inspected.values()]).toEqual(Array(11).fill(1))
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

	test("generates the complete Agency command fast paths with precedence", () => {
		const body = managedBody(managedWorkbaseAgents)

		expect(body.indexOf("## Command Fast Paths")).toBeLessThan(
			body.indexOf("## Bootstrap"),
		)
		expect(managedWorkbaseAgents).toContain(
			"take precedence over separately installed Agency skill guidance",
		)
		for (const recipe of [
			"Create a single-phase task only",
			"agency work prepare <slug> --evidence",
			"Materialize an existing execution unit without starting it",
			"agency sync <task> [phase] --json",
			"agency phase create <task> <new-phase> --first-phase <existing-phase>",
			"agency archive task <task> --dry-run --json",
			"agency task create <slug> --review <alias>",
			"agency status --json",
			"agency task status <task> dropped --if-revision <revision> --json",
			"Continue already materialized work",
			"agency pr create <task> [phase]",
			"agency finish <task> [phase] --session-id <id>",
			"agency task create <slug> --multi-phase",
			"agency task handoff <investigation-task> <new-task>",
			"agency review refresh <task> --if-revision <revision> --json",
		]) {
			expect(managedWorkbaseAgents).toContain(recipe)
		}
		expect(managedWorkbaseAgents).toContain("agency push --json")
		expect(managedWorkbaseAgents).toContain("agency-execution-v1")
		expect(managedWorkbaseAgents).toContain("agency context . --json")
		expect(managedWorkbaseAgents).toContain(
			"Pass `--full` only when document prose or low-level VCS details are needed",
		)
		expect(managedWorkbaseAgents).not.toContain(
			"agency context . --full --json",
		)
		expect(managedWorkbaseAgents).toContain(
			"Never pass `--work` or `--auto` to `agency task create`",
		)
		expect(managedWorkbaseAgents).toContain(
			"Use `agency <command> --help` only as a recovery",
		)
		expect(managedWorkbaseAgents).not.toContain("`agency --help`")
		expect(managedWorkbaseAgents).not.toContain(
			"`agency worktree prepare <task>",
		)
	})

	test("generates a dynamic workbase plugin", () => {
		expect(managedWorkbaseOpencodePlugin).toContain(
			"process.env.AGENCY_WRITABLE_CHECKOUT",
		)
		expect(managedWorkbaseOpencodePlugin).toContain(
			'import type { Plugin, PluginModule } from "@opencode-ai/plugin/v1"',
		)
		expect(managedWorkbaseOpencodePlugin).toContain(
			"export const AgencyPlugin = plugin",
		)
		expect(managedWorkbaseOpencodePlugin).toContain('id: "agency"')
		expect(managedWorkbaseOpencodePlugin).toContain("setup,")
		expect(managedWorkbaseOpencodePlugin).toContain("server: plugin")
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
		expect(managedWorkbaseOpencodePlugin).toContain('"chat.message"')
		expect(managedWorkbaseOpencodePlugin).toContain(
			"if (!Array.isArray(parts)) return",
		)
		expect(managedWorkbaseOpencodePlugin).toContain(
			'"experimental.chat.system.transform"',
		)
		expect(managedWorkbaseOpencodePlugin).toContain('"shell.env"')
		expect(managedWorkbaseOpencodePlugin).toContain(
			"if (context?.target !== launchTarget) return",
		)
		expect(managedWorkbaseOpencodePlugin).toContain(
			"agencyContext(directory, false)",
		)
		expect(managedWorkbaseOpencodePlugin).toContain(
			"result.validation?.valid !== true",
		)
		expect(managedWorkbaseOpencodePlugin).toContain(
			"dirname(document) !== resolve(directory)",
		)
		expect(managedWorkbaseOpencodePlugin).toContain(
			"!result.authority?.writable?.checkoutPath",
		)
		expect(managedWorkbaseOpencodePlugin).toContain('status !== "working"')
		expect(managedWorkbaseOpencodePlugin).toContain(
			"output.env.AGENCY_SESSION_ID = sessionID",
		)
		expect(managedWorkbaseOpencodePlugin).toContain(
			"Do not invoke agency work for this target",
		)
		expect(managedWorkbaseOpencodePlugin).toContain(
			"as the default implementation directory",
		)
		expect(managedWorkbaseOpencodePlugin).toContain(
			"Set each tool's working directory to that checkout when supported",
		)
		expect(managedWorkbaseOpencodePlugin).toContain(
			"Run Agency lifecycle and context commands from the task or phase directory",
		)
		expect(managedWorkbaseOpencodePlugin).toContain(
			"reference checkouts reported by Agency context are read-only",
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

	const testWorkerIdentity = async ({
		target,
		launchTarget,
		phase,
	}: {
		readonly target:
			| { readonly kind: "task"; readonly taskId: string }
			| {
					readonly kind: "phase"
					readonly taskId: string
					readonly phaseId: string
			  }
		readonly launchTarget: string
		readonly phase?: string
	}) => {
		const path = join(root, "agency-repository-skills.ts")
		const checkoutPath = join(root, "code/agency")
		const contextResponse = JSON.stringify({
			version: 1,
			ok: true,
			result: {
				workbase: { root },
				target: {
					...target,
					path: join(root, phase ? "PHASE.md" : "TASK.md"),
				},
				authority: {
					mode: "execution",
					writable: { checkoutPath },
				},
				documents: phase
					? { phase: { data: { status: "working" } } }
					: { task: { data: { status: "working" } } },
				validation: { valid: true, warnings: [] },
			},
		})
		await Bun.write(
			path,
			managedWorkbaseOpencodePlugin
				.replace("const contextTarget =", "export const contextTarget =")
				.replace("const agencyContext =", "export const agencyContext =")
				.replace(
					"const workerLaunchTarget =",
					"export const workerLaunchTarget =",
				),
		)
		const originalSpawn = Bun.spawn
		Bun.spawn = (() =>
			({
				stdout: new Response(contextResponse).body!,
				exited: Promise.resolve(0),
			}) as ReturnType<typeof Bun.spawn>) as typeof Bun.spawn
		try {
			const generated = await import(
				`${pathToFileURL(path).href}?worker-identity=${encodeURIComponent(launchTarget)}`
			)
			expect(
				generated.workerLaunchTarget([
					{
						type: "text",
						text: `Agency worker launch target: ${launchTarget}. Start the task.`,
					},
				]),
			).toBe(launchTarget)
			expect(generated.workerLaunchTarget(undefined)).toBeUndefined()
			expect(
				generated.contextTarget({
					target,
					authority: { mode: "execution" },
				}),
			).toBe(launchTarget)
			expect(await generated.agencyContext(root)).toMatchObject({
				root,
				target: launchTarget,
				task: "example",
				phase,
			})
			expect(generated.default).toMatchObject({
				id: "agency",
				setup: expect.any(Function),
				server: generated.AgencyPlugin,
			})
			const hooks = await generated.AgencyPlugin({ directory: root } as never)
			await hooks["chat.message"]!(
				{ sessionID: "worker-session" } as never,
				{
					parts: [
						{
							type: "text",
							text: `Agency worker launch target: ${launchTarget}. Start the task.`,
						},
					],
				} as never,
			)
			await hooks["chat.message"]!(
				{ sessionID: "mismatched-session" } as never,
				{
					parts: [
						{
							type: "text",
							text: "Agency worker launch target: execution-unit:task/other. Start the task.",
						},
					],
				} as never,
			)

			const system = { system: [] as string[] }
			await hooks["experimental.chat.system.transform"]!(
				{ sessionID: "worker-session" } as never,
				system,
			)
			expect(system.system).toHaveLength(1)
			expect(system.system[0]).toContain(`active worker for ${launchTarget}`)
			expect(system.system[0]).toContain(
				`${checkoutPath} as the default implementation directory`,
			)
			expect(system.system[0]).toContain(
				"Run Agency lifecycle and context commands from the task or phase directory",
			)
			expect(system.system[0]).toContain(
				"reference checkouts reported by Agency context are read-only",
			)
			const mismatchedSystem = { system: [] as string[] }
			await hooks["experimental.chat.system.transform"]!(
				{ sessionID: "mismatched-session" } as never,
				mismatchedSystem,
			)
			expect(mismatchedSystem.system).toEqual([])

			const shell = { env: {} as Record<string, string> }
			await hooks["shell.env"]!({ sessionID: "worker-session" } as never, shell)
			expect(shell.env).toMatchObject({
				AGENCY_SESSION_ID: "worker-session",
				AGENCY_TARGET: launchTarget,
				AGENCY_WORKBASE: root,
				AGENCY_TASK_ID: "example",
				AGENCY_WRITABLE_CHECKOUT: checkoutPath,
			})
			if (phase) expect(shell.env.AGENCY_PHASE_ID).toBe(phase)
		} finally {
			Bun.spawn = originalSpawn
		}
	}

	test("binds validated task worker identity to an OpenCode session", () =>
		testWorkerIdentity({
			target: { kind: "task", taskId: "example" },
			launchTarget: "execution-unit:task/example",
		}))

	test("binds validated phase worker identity to an OpenCode session", () =>
		testWorkerIdentity({
			target: { kind: "phase", taskId: "example", phaseId: "build" },
			launchTarget: "execution-unit:phase/example/build",
			phase: "build",
		}))

	test("registers the workbase reference through the OpenCode V2 API", async () => {
		const path = join(root, ".opencode/plugins/agency-repository-skills.ts")
		await write(
			root,
			".opencode/plugins/agency-repository-skills.ts",
			managedWorkbaseOpencodePlugin,
		)
		const generated = await import(`${pathToFileURL(path).href}?v2-setup`)
		let reference:
			| {
					name: string
					source: { type: string; path: string; description: string }
			  }
			| undefined

		await generated.default.setup({
			reference: {
				transform: async (callback: (references: unknown) => void) =>
					callback({
						list: () => [],
						add: (
							name: string,
							source: {
								type: string
								path: string
								description: string
							},
						) => {
							reference = { name, source }
						},
					}),
			},
			skill: { transform: async () => {} },
		})

		expect(reference).toEqual({
			name: "workbase",
			source: {
				type: "local",
				path: root,
				description:
					"Complete Agency workbase context; write authority still comes only from agency context",
			},
		})
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
		expect(body).toContain("agency next --json")
		expect(body).toContain("agency <command> --help")
		expect(body).toContain("authority.writable.checkoutPath")
		expect(body).toContain("authority.documents.writable")
		expect(body).toContain("Only `done` satisfies a dependency")
		expect(body).toContain("Require explicit user intent")
		expect(body).toContain(
			"explicit request for a new, separate, or follow-up item",
		)
		expect(body).toContain("agency task handoff")
		expect(body).toContain(
			"Creation and handoff do not imply worktree preparation",
		)
		expect(body).toContain("changing repository")
		expect(body).toMatch(
			/archiving, restoring,\s+dropping, reopening, or completing work without a pull request/,
		)
		expect(body).toContain("Never invent entity IDs")
		expect(body).toContain("Preserve parent backlinks")
		expect(body).toContain("dirty-worktree, active-claim, revision")
		expect(body).toContain("`agency work` is the human launch flow")
		expect(body).toContain("Agency worker launch target: <target>.")
		expect(body).toContain("environment variables and a generated")
		expect(body).toContain("the initial instruction is a generated")
		expect(body).toContain(
			"External session state is never part of worker identity",
		)
		expect(body).toMatch(/If\s+the prompt\s+and context disagree/)
		expect(body).toContain("marks execution work")
		expect(body).toContain("without creating a claim")
		expect(body).toContain("formatting, type checks, build, dead-code checks")
		expect(body).toContain("Review and commit the diff")
		expect(body).toContain("Use `agency push`")
		expect(body).toContain("never authors semantic commit descriptions")
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
		expect(body).toContain("`agency sync`")
		expect(body).toContain("`--no-pull-request --summary <text>`")
		expect(body).toContain("`TASK.md` or `PHASE.md`")
		expect(body).toContain("PR state, current head, diff summary")
		expect(body).toContain("Run `agency validate` before reporting completion")
		expect(body).toContain("agency integration status")
		expect(body).not.toContain("SKILL.md")
		expect(body).not.toContain("~/.agents")
		expect(body).not.toContain(".opencode/command/agency.md")
	})

	test("generates repository add and setup guidance", () => {
		const body = managedBody(managedWorkbaseAgents)

		expect(body).toContain("## Adding a Repository")
		expect(body).toContain("agency repo add <alias> <remote> --json")
		expect(body).toContain(
			"`agency repo add` mutates immediately and does not accept `--apply`",
		)
		expect(body).toContain("agency repo setup --dry-run")
		expect(body).toContain("agency repo setup --apply")
		expect(body).toMatch(
			/repositories that are already declared\s+but locally missing/,
		)
		expect(body).toContain("Do not edit\n`agency.json` or `repos/` manually")
		expect(body).toMatch(
			/agency repo verify <alias> --json\s+agency validate --json/,
		)
		expect(body).toMatch(
			/run only these checks, in order, unless\s+`agency context` reports a relevant problem/,
		)
	})

	test("configures Agency planning with complete workbase access", () => {
		const config = JSON.parse(managedBody(managedWorkbaseOpencode))

		expect(config.instructions).toEqual([".agency/AGENTS.md"])
		expect(config.agent).toEqual({
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
		expect(config.agent["agency-plan"].prompt).toContain(
			"Explicit-new intent overrides reuse",
		)
		expect(config.agent.agency).toBeUndefined()
		expect(config.agent["agency-plan"].prompt).toContain(
			"Start with `agency context . --json`",
		)
		expect(config.agent["agency-plan"].prompt).toContain(
			"Pass `--full` only when document prose or low-level VCS details are needed",
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
				join(root, ".opencode/plugins/agency-repository-skills.ts"),
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

	test("upgrades prior managed instructions without changing owner instructions", async () => {
		const ownerInstructions = "# User-owned workbase instructions\n"
		const priorInstructions = managed(
			"<!-- agency-managed: sha256=",
			"# Previous Agency instructions\n",
			" -->",
		)
		await write(root, "AGENTS.md", ownerInstructions)
		await write(root, ".agency/AGENTS.md", priorInstructions)

		const result = await sync(root)

		expect(result.files[0]).toMatchObject({
			name: "agents",
			state: "managed",
			changed: true,
		})
		expect(await Bun.file(join(root, ".agency/AGENTS.md")).text()).toBe(
			managedWorkbaseAgents,
		)
		expect(await Bun.file(join(root, "AGENTS.md")).text()).toBe(
			ownerInstructions,
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

	test("removes a checksum-valid workbase-local Pi extension", async () => {
		const body = "export default function legacyAgencyExtension() {}\n"
		const checksum = createHash("sha256").update(body).digest("hex")
		const path = join(root, ".pi/extensions/agency-workbase.ts")
		await write(
			root,
			".pi/extensions/agency-workbase.ts",
			`// agency-managed: sha256=${checksum}\n\n${body}`,
		)

		await sync(root)
		expect(await Bun.file(path).exists()).toBe(false)
		expect(await Bun.file(join(root, ".pi")).exists()).toBe(false)
	})

	test("preserves a customized workbase-local Pi extension", async () => {
		const custom = "export default function customPiExtension() {}\n"
		const path = join(root, ".pi/extensions/agency-workbase.ts")
		await write(root, ".pi/extensions/agency-workbase.ts", custom)

		await sync(root)
		expect(await Bun.file(path).text()).toBe(custom)
	})

	test("migrates a checksum-valid plugin from the legacy singular path", async () => {
		const legacyPath = join(
			root,
			".opencode/plugin/agency-repository-skills.ts",
		)
		const pluginPath = join(
			root,
			".opencode/plugins/agency-repository-skills.ts",
		)
		await write(
			root,
			".opencode/plugin/agency-repository-skills.ts",
			managedWorkbaseOpencodePlugin,
		)

		const result = await sync(root)

		expect(result.files[2]).toMatchObject({
			name: "opencode-plugin",
			path: pluginPath,
			state: "managed",
			changed: true,
		})
		expect(await Bun.file(pluginPath).text()).toBe(
			managedWorkbaseOpencodePlugin,
		)
		expect(await Bun.file(legacyPath).exists()).toBe(false)
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
