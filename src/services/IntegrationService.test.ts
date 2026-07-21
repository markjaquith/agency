import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { createHash } from "node:crypto"
import { mkdir, stat, symlink, unlink, utimes } from "node:fs/promises"
import { dirname, join } from "node:path"
import { cleanupTempDir, createTempDir, runTestEffect } from "../test-utils"
import { managedWorkbaseAgents } from "../workbase/agents-file"
import {
	canUpdateManagedWorkbaseOpencodeCommand,
	managedWorkbaseOpencodeCommand,
} from "../workbase/opencode-command-file"
import { managedWorkbaseOpencode } from "../workbase/opencode-file"
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
		])
		expect(await Bun.file(join(root, ".agency/AGENTS.md")).exists()).toBe(false)

		await write(root, ".agency/AGENTS.md", managedWorkbaseAgents)
		await write(root, ".opencode/opencode.jsonc", managedWorkbaseOpencode)
		await write(
			root,
			".opencode/command/agency.md",
			managedWorkbaseOpencodeCommand,
		)
		expect((await status(root)).files.map(({ state }) => state)).toEqual([
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
		])
	})

	test("generates a positional OpenCode command for Agency workflows", () => {
		expect(managedWorkbaseOpencodeCommand).toContain(
			"description: Operate Agency work",
		)
		expect(managedWorkbaseOpencodeCommand).toContain("Workflow: `$1`")
		expect(managedWorkbaseOpencodeCommand).toContain("Optional target: `$2`")
		expect(managedWorkbaseOpencodeCommand).toContain(
			"Complete request: `$ARGUMENTS`",
		)
		for (const workflow of [
			"start",
			"status",
			"next",
			"validate",
			"finish",
			"help",
		]) {
			expect(managedWorkbaseOpencodeCommand).toContain(`- \`${workflow}\`:`)
		}
		expect(managedWorkbaseOpencodeCommand).toContain("Never run `agency work`")
		expect(
			canUpdateManagedWorkbaseOpencodeCommand(managedWorkbaseOpencodeCommand),
		).toBe(true)
		expect(
			canUpdateManagedWorkbaseOpencodeCommand(
				managedWorkbaseOpencodeCommand.replace("Workflow: `$1`", "Workflow"),
			),
		).toBe(false)
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
		expect(body).toContain(".opencode/command/agency.md")
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
					"Agency planning mode. May edit only Agency planning documents.",
				mode: "primary",
				prompt: expect.stringContaining("You are in Agency Plan mode"),
				permission: {
					question: "allow",
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
			{ name: "opencode-command", state: "managed", changed: true },
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
			await Bun.file(join(root, ".opencode/command/agency.md")).text(),
		).toBe(managedWorkbaseOpencodeCommand)

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

	test("preserves user-owned OpenCode commands at either supported path", async () => {
		const custom = "---\ndescription: Custom Agency command\n---\n\nCustom.\n"
		await write(root, ".opencode/commands/agency.md", custom)

		let result = await sync(root)
		expect(result.files[2]).toMatchObject({
			name: "opencode-command",
			path: join(root, ".opencode/commands/agency.md"),
			state: "customized",
			changed: false,
		})
		expect(
			await Bun.file(join(root, ".opencode/command/agency.md")).exists(),
		).toBe(false)

		await unlink(join(root, ".opencode/commands/agency.md"))
		await write(root, ".opencode/command/agency.md", custom)
		result = await sync(root)
		expect(result.files[2]).toMatchObject({
			path: join(root, ".opencode/command/agency.md"),
			state: "customized",
			changed: false,
		})
		expect(
			await Bun.file(join(root, ".opencode/command/agency.md")).text(),
		).toBe(custom)
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
