import { createHash } from "node:crypto"

const managedHeaderPattern =
	/^\/\/ agency-managed: sha256=([a-f0-9]{64})\r?\n\r?\n/

const checksum = (content: string) =>
	createHash("sha256").update(content).digest("hex")

const body = () =>
	`${JSON.stringify(
		{
			$schema: "https://opencode.ai/config.json",
			instructions: [".agency/AGENTS.md"],
			agent: {
				agency: {
					description:
						"Handles Agency workbase orchestration and workflow operations with the Agency CLI",
					mode: "subagent",
					prompt:
						"You are the Agency workflow specialist. Use the Agency CLI to handle delegated workbase orchestration and workflow operations. Always start with `agency context . --json`, follow the managed Agency instructions and reported authority, use Agency commands for durable mutations, and report the resulting state concisely.",
				},
			},
			references: {
				workbase: {
					path: "..",
					description:
						"Complete Agency workbase context; write authority still comes only from agency context",
				},
			},
		},
		null,
		2,
	)}\n`

const renderManagedWorkbaseOpencode = (content: string) =>
	`// agency-managed: sha256=${checksum(content)}\n\n${content}`

export const managedWorkbaseOpencode = renderManagedWorkbaseOpencode(body())

export const canUpdateManagedWorkbaseOpencode = (content: string) => {
	const match = content.match(managedHeaderPattern)
	if (!match?.[1]) return false

	return checksum(content.slice(match[0].length)) === match[1]
}
