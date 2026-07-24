import { createHash } from "node:crypto"

const managedHeaderPattern =
	/^\/\/ agency-managed: sha256=([a-f0-9]{64})\r?\n\r?\n/

const checksum = (content: string) =>
	createHash("sha256").update(content).digest("hex")

const body = () =>
	`${JSON.stringify(
		{
			$schema: "https://opencode.ai/tui.json",
			plugin: ["./tui/agency-debug.ts"],
		},
		null,
		2,
	)}\n`

const renderManagedWorkbaseOpencodeTui = (content: string) =>
	`// agency-managed: sha256=${checksum(content)}\n\n${content}`

export const managedWorkbaseOpencodeTui =
	renderManagedWorkbaseOpencodeTui(body())

export const canUpdateManagedWorkbaseOpencodeTui = (content: string) => {
	const match = content.match(managedHeaderPattern)
	if (!match?.[1]) return false

	return checksum(content.slice(match[0].length)) === match[1]
}
