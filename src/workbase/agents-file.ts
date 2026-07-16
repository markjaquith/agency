import { createHash } from "node:crypto"
import agentsTemplate from "./AGENTS.md" with { type: "text" }

const managedHeaderPattern =
	/^<!-- agency-managed: sha256=([a-f0-9]{64}) -->\r?\n\r?\n/

const checksum = (content: string) =>
	createHash("sha256").update(content).digest("hex")

const canonicalBody = agentsTemplate.endsWith("\n")
	? agentsTemplate
	: `${agentsTemplate}\n`

const renderManagedWorkbaseAgents = (body: string = canonicalBody) =>
	`<!-- agency-managed: sha256=${checksum(body)} -->\n\n${body}`

export const managedWorkbaseAgents = renderManagedWorkbaseAgents()

export const canUpdateManagedWorkbaseAgents = (content: string) => {
	const match = content.match(managedHeaderPattern)
	if (!match?.[1]) return false

	return checksum(content.slice(match[0].length)) === match[1]
}
