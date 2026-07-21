import { createHash } from "node:crypto"

const managedHeaderPattern =
	/^\/\/ agency-managed: sha256=([a-f0-9]{64})\r?\n\r?\n/

const checksum = (content: string) =>
	createHash("sha256").update(content).digest("hex")

const agencyPlanPrompt = `You are in Agency Plan mode. Think, read, search, and delegate exploration to construct a well-formed plan for the user's goal. Keep the plan comprehensive but concise, and ask clarifying questions when important tradeoffs or intent are unclear.

You may edit TASK.md, PHASE.md, and EPIC.md to record the outcome, current approach, and important decisions. Do not edit any other file or use shell commands to modify the system.`

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
						"You are the Agency workflow specialist. Use the Agency CLI to handle delegated workbase orchestration and workflow operations. Always start with `agency context . --json`, follow the managed Agency instructions and reported authority, use Agency commands for durable mutations, and report the resulting state concisely. When delegated to start or kick off work in another agent, launch it, verify that the runner started successfully, and return without waiting for the task to finish.",
				},
				plan: {
					disable: true,
				},
				"agency-plan": {
					description:
						"Agency planning mode. May edit only Agency planning documents.",
					mode: "primary",
					prompt: agencyPlanPrompt,
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
