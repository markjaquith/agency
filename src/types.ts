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
	{ name: "AGENTS.md", defaultContent: "" },
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
]
