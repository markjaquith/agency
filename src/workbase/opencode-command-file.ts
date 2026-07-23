import { createHash } from "node:crypto"
import commandTemplate from "./AGENCY_COMMAND.md" with { type: "text" }

const managedHeaderPattern =
	/^---\r?\n# agency-managed: sha256=([a-f0-9]{64})\r?\n/

const checksum = (content: string) =>
	createHash("sha256").update(content).digest("hex")

const canonicalBody = commandTemplate.endsWith("\n")
	? commandTemplate
	: `${commandTemplate}\n`

const renderManagedWorkbaseOpencodeCommand = (
	content: string = canonicalBody,
) =>
	content.replace(
		/^---\n/,
		`---\n# agency-managed: sha256=${checksum(content)}\n`,
	)

export const managedWorkbaseOpencodeCommand =
	renderManagedWorkbaseOpencodeCommand()

export const canUpdateManagedWorkbaseOpencodeCommand = (content: string) => {
	const match = content.match(managedHeaderPattern)
	if (!match?.[1]) return false

	return checksum(content.replace(managedHeaderPattern, "---\n")) === match[1]
}
