import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { cleanupTempDir, createTempDir } from "../src/test-utils"
import {
	installPiExtension,
	piExtensionPath,
	uninstallPiExtension,
} from "./install-pi-extension"

describe("Pi extension lifecycle", () => {
	let root: string | undefined

	afterEach(async () => {
		if (root) await cleanupTempDir(root)
		root = undefined
	})

	test("uses Pi's global extension directory", () => {
		expect(piExtensionPath("/home/example")).toBe(
			"/home/example/.pi/agent/extensions/agency.ts",
		)
	})

	test("installs, updates, and removes the global extension", async () => {
		root = await createTempDir()
		const source = join(root, "agency.ts")
		const destination = piExtensionPath(root)
		await Bun.write(source, "first\n")

		await installPiExtension(source, destination)
		expect(await Bun.file(destination).text()).toBe("first\n")

		await Bun.write(source, "second\n")
		await installPiExtension(source, destination)
		expect(await Bun.file(destination).text()).toBe("second\n")

		await uninstallPiExtension(destination)
		expect(await Bun.file(destination).exists()).toBe(false)
		await uninstallPiExtension(destination)
	})
})
