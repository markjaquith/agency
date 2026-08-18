import { cp, mkdir, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export const piExtensionPath = (home = homedir()) =>
	join(home, ".pi", "agent", "extensions", "agency.ts")

export const installPiExtension = async (
	source = join(import.meta.dir, "..", "pi-extensions", "agency.ts"),
	destination = piExtensionPath(),
) => {
	await mkdir(dirname(destination), { recursive: true })
	await cp(source, destination)
}

export const uninstallPiExtension = async (destination = piExtensionPath()) => {
	await rm(destination, { force: true })
}

if (import.meta.main) {
	const command = process.argv[2] ?? "install"
	if (command === "install") await installPiExtension()
	else if (command === "uninstall") await uninstallPiExtension()
	else throw new Error(`Unknown Pi extension lifecycle command: ${command}`)
}
