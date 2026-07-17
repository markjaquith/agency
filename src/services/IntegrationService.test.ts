import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { createHash } from "node:crypto"
import { mkdir, symlink, unlink } from "node:fs/promises"
import { dirname, join } from "node:path"
import { cleanupTempDir, createTempDir, runTestEffect } from "../test-utils"
import { managedWorkbaseAgents } from "../workbase/agents-file"
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
		])
		expect(await Bun.file(join(root, "AGENTS.md")).exists()).toBe(false)

		await write(root, "AGENTS.md", managedWorkbaseAgents)
		await write(root, ".opencode/opencode.jsonc", managedWorkbaseOpencode(root))
		expect((await status(root)).files.map(({ state }) => state)).toEqual([
			"managed",
			"managed",
		])
	})

	test("reports customized and checksum-safe drifted files", async () => {
		await write(root, "AGENTS.md", "# Custom instructions\n")
		await write(
			root,
			".opencode/opencode.jsonc",
			managed("// agency-managed: sha256=", '{"references":{}}\n'),
		)

		expect((await status(root)).files.map(({ state }) => state)).toEqual([
			"customized",
			"drifted",
		])
	})

	test("treats an existing JSON OpenCode config as customized", async () => {
		await write(root, ".opencode/opencode.json", '{"model":"test/model"}\n')

		const result = await status(root)
		expect(result.files[1]).toEqual({
			name: "opencode",
			path: join(root, ".opencode/opencode.json"),
			state: "customized",
		})
	})

	test("syncs missing and drifted files while preserving customized files", async () => {
		const customAgents = "# Custom instructions\n"
		await write(root, "AGENTS.md", customAgents)
		await write(
			root,
			".opencode/opencode.jsonc",
			managed("// agency-managed: sha256=", '{"references":{}}\n'),
		)

		const first = await sync(root)
		expect(first.files).toMatchObject([
			{ name: "agents", state: "customized", changed: false },
			{ name: "opencode", state: "managed", changed: true },
		])
		expect(await Bun.file(join(root, "AGENTS.md")).text()).toBe(customAgents)
		expect(await Bun.file(join(root, ".opencode/opencode.jsonc")).text()).toBe(
			managedWorkbaseOpencode(root),
		)

		await unlink(join(root, "AGENTS.md"))
		const second = await sync(root)
		expect(second.files[0]).toMatchObject({ state: "managed", changed: true })
		expect(await Bun.file(join(root, "AGENTS.md")).text()).toBe(
			managedWorkbaseAgents,
		)
	})

	test("does not overwrite managed files whose checksums no longer match", async () => {
		const tampered = `${managed(
			"<!-- agency-managed: sha256=",
			"# Previous Agency instructions\n",
			" -->",
		)}User edit\n`
		await write(root, "AGENTS.md", tampered)

		const result = await sync(root)
		expect(result.files[0]).toMatchObject({
			state: "customized",
			changed: false,
		})
		expect(await Bun.file(join(root, "AGENTS.md")).text()).toBe(tampered)
	})

	test("does not follow symlinked integration files", async () => {
		const target = join(root, "custom-agents.md")
		await Bun.write(target, "# External instructions\n")
		await symlink(target, join(root, "AGENTS.md"))

		const result = await sync(root)
		expect(result.files[0]).toMatchObject({
			state: "customized",
			changed: false,
		})
		expect(await Bun.file(target).text()).toBe("# External instructions\n")
	})
})
