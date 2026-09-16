import { createHash } from "node:crypto"
import { constants } from "node:fs"
import {
	copyFile,
	lstat,
	mkdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const ownershipVersion = 1

type LifecycleResult = {
	status: "installed" | "updated" | "removed" | "absent" | "skipped"
	destination: string
}

type Ownership = {
	version: typeof ownershipVersion
	sha256: string
}

export const piExtensionPath = (home = homedir()) =>
	join(home, ".pi", "agent", "extensions", "agency.ts")

export const piExtensionOwnershipPath = (destination = piExtensionPath()) =>
	`${destination}.agency-managed.json`

const digest = (contents: Uint8Array) =>
	createHash("sha256").update(contents).digest("hex")

const readOwnership = async (
	destination: string,
): Promise<Ownership | undefined> => {
	try {
		const marker = await lstat(piExtensionOwnershipPath(destination))
		if (!marker.isFile() || marker.isSymbolicLink()) return
		const ownership = JSON.parse(
			await readFile(piExtensionOwnershipPath(destination), "utf8"),
		) as Partial<Ownership>
		if (
			ownership.version === ownershipVersion &&
			typeof ownership.sha256 === "string"
		)
			return ownership as Ownership
	} catch {
		return
	}
}

const writeOwnership = async (
	destination: string,
	sha256: string,
	exclusive = false,
) => {
	await writeFile(
		piExtensionOwnershipPath(destination),
		`${JSON.stringify({ version: ownershipVersion, sha256 })}\n`,
		exclusive ? { flag: "wx" } : undefined,
	)
}

export const installPiExtension = async (
	source = join(import.meta.dir, "..", "pi-extensions", "agency.ts"),
	destination = piExtensionPath(),
): Promise<LifecycleResult> => {
	await mkdir(dirname(destination), { recursive: true })
	const sourceContents = await readFile(source)
	const sourceDigest = digest(sourceContents)

	try {
		await copyFile(source, destination, constants.COPYFILE_EXCL)
		try {
			await writeOwnership(destination, sourceDigest, true)
		} catch (error) {
			await rm(destination, { force: true })
			if ((error as NodeJS.ErrnoException).code === "EEXIST") {
				return { status: "skipped", destination }
			}
			throw error
		}
		return { status: "installed", destination }
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
	}

	const ownership = await readOwnership(destination)
	const destinationFile = await lstat(destination)
	if (!destinationFile.isFile() || destinationFile.isSymbolicLink()) {
		return { status: "skipped", destination }
	}
	const destinationDigest = digest(await readFile(destination))
	if (!ownership || ownership.sha256 !== destinationDigest) {
		return { status: "skipped", destination }
	}

	await copyFile(source, destination)
	await writeOwnership(destination, sourceDigest)
	return { status: "updated", destination }
}

export const uninstallPiExtension = async (
	destination = piExtensionPath(),
): Promise<LifecycleResult> => {
	const ownership = await readOwnership(destination)
	let destinationContents: Buffer
	try {
		const destinationFile = await lstat(destination)
		if (!destinationFile.isFile() || destinationFile.isSymbolicLink()) {
			return { status: "skipped", destination }
		}
		destinationContents = await readFile(destination)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
		await rm(piExtensionOwnershipPath(destination), { force: true })
		return { status: "absent", destination }
	}

	if (!ownership || ownership.sha256 !== digest(destinationContents)) {
		return { status: "skipped", destination }
	}

	await rm(destination)
	await rm(piExtensionOwnershipPath(destination), { force: true })
	return { status: "removed", destination }
}

if (import.meta.main) {
	const command = process.argv[2] ?? "install"
	const result =
		command === "install"
			? await installPiExtension()
			: command === "uninstall"
				? await uninstallPiExtension()
				: undefined
	if (!result)
		throw new Error(`Unknown Pi extension lifecycle command: ${command}`)
	if (result.status === "skipped") {
		console.warn(
			`Agency left the existing Pi extension unchanged because it cannot prove ownership: ${result.destination}`,
		)
	}
}
