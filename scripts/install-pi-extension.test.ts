import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, symlink } from "node:fs/promises"
import { join } from "node:path"
import { cleanupTempDir, createTempDir } from "../src/test-utils"
import {
	installPiExtension,
	piExtensionOwnershipPath,
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

	test("installs, updates, and removes an Agency-owned extension", async () => {
		root = await createTempDir()
		const source = join(root, "agency.ts")
		const destination = piExtensionPath(root)
		await Bun.write(source, "first\n")

		expect((await installPiExtension(source, destination)).status).toBe(
			"installed",
		)
		expect(await Bun.file(destination).text()).toBe("first\n")
		expect(
			await Bun.file(piExtensionOwnershipPath(destination)).exists(),
		).toBeTrue()

		await Bun.write(source, "second\n")
		expect((await installPiExtension(source, destination)).status).toBe(
			"updated",
		)
		expect(await Bun.file(destination).text()).toBe("second\n")

		expect((await uninstallPiExtension(destination)).status).toBe("removed")
		expect(await Bun.file(destination).exists()).toBe(false)
		expect(await Bun.file(piExtensionOwnershipPath(destination)).exists()).toBe(
			false,
		)
		expect((await uninstallPiExtension(destination)).status).toBe("absent")
	})

	test("does not update or uninstall an unmanaged extension", async () => {
		root = await createTempDir()
		const source = join(root, "source.ts")
		const destination = piExtensionPath(root)
		await mkdir(join(root, ".pi", "agent", "extensions"), { recursive: true })
		await Bun.write(source, "managed\n")
		await Bun.write(destination, "user managed\n")

		expect((await installPiExtension(source, destination)).status).toBe(
			"skipped",
		)
		expect(await Bun.file(destination).text()).toBe("user managed\n")
		expect((await uninstallPiExtension(destination)).status).toBe("skipped")
		expect(await Bun.file(destination).text()).toBe("user managed\n")
	})

	test("preserves a managed extension that the user later edits", async () => {
		root = await createTempDir()
		const source = join(root, "source.ts")
		const destination = piExtensionPath(root)
		await Bun.write(source, "first\n")
		await installPiExtension(source, destination)
		await Bun.write(destination, "user edit\n")
		await Bun.write(source, "second\n")

		expect((await installPiExtension(source, destination)).status).toBe(
			"skipped",
		)
		expect((await uninstallPiExtension(destination)).status).toBe("skipped")
		expect(await Bun.file(destination).text()).toBe("user edit\n")
	})

	test("respects an unmanaged extension through a symlinked Pi directory", async () => {
		root = await createTempDir()
		const home = join(root, "home")
		const managedPi = join(root, "dotfiles", ".pi")
		await mkdir(join(managedPi, "agent", "extensions"), { recursive: true })
		await mkdir(home)
		await symlink(managedPi, join(home, ".pi"))
		const source = join(root, "source.ts")
		const destination = piExtensionPath(home)
		await Bun.write(source, "package\n")
		await Bun.write(destination, "tracked\n")

		expect((await installPiExtension(source, destination)).status).toBe(
			"skipped",
		)
		expect((await uninstallPiExtension(destination)).status).toBe("skipped")
		expect(await Bun.file(destination).text()).toBe("tracked\n")
	})
})
