export interface Command {
	name: string
	description: string
	run: (args: string[], options: Record<string, any>) => Promise<void>
	help: string
}

export interface ManagedFile {
	name: string
	defaultContent?: string
}

// Files managed by agency
export const MANAGED_FILES: ManagedFile[] = [
	{
		name: "AGENTS.md",
		defaultContent: `# Agent Instructions

## TASK.md

The \`TASK.md\` file describes the task being performed and should be kept updated as work progresses. This file serves as a living record of:

- What is being built or fixed
- Current progress and status
- Remaining work items
- Any important context or decisions

All work on this repository should begin by reading and understanding \`TASK.md\`. Whenever any significant progress is made, \`TASK.md\` should be updated to reflect the current state of work.

See \`TASK.md\` for the current task description and progress.
`,
	},
	{
		name: "opencode.json",
		defaultContent: JSON.stringify(
			{
				$schema: "https://opencode.ai/config.json",
				instructions: ["TASK.md"],
			},
			null,
			2,
		),
	},
	{
		name: "TASK.md",
		defaultContent: `{task}

## Tasks

- [ ] Populate this list
`,
	},
]
