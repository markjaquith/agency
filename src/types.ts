import { join } from "node:path"

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

/**
 * Load template content from the templates directory.
 * Falls back to inline defaults if files cannot be read (e.g., in bundled packages).
 */
async function loadTemplateContent(fileName: string): Promise<string> {
	try {
		// Try to load from the templates directory relative to this file's location
		const templatePath = join(import.meta.dir, "..", "templates", fileName)
		const file = Bun.file(templatePath)
		if (await file.exists()) {
			return await file.text()
		}
	} catch (error) {
		// Fall through to defaults if file loading fails
	}

	// Return inline defaults as fallback
	const defaults: Record<string, string> = {
		"AGENTS.md": `# Agent Instructions

## TASK.md

The \`TASK.md\` file describes the task being performed and should be kept updated as work progresses. This file serves as a living record of:

- What is being built or fixed
- Current progress and status
- Remaining work items
- Any important context or decisions

All work on this repository should begin by reading and understanding \`TASK.md\`. Whenever any significant progress is made, \`TASK.md\` should be updated to reflect the current state of work.

See \`TASK.md\` for the current task description and progress.
`,
		"TASK.md": `{task}

## Tasks

- [ ] Populate this list
`,
		"opencode.json": JSON.stringify(
			{
				$schema: "https://opencode.ai/config.json",
				instructions: ["TASK.md"],
			},
			null,
			2,
		),
	}

	return defaults[fileName] || ""
}

/**
 * Initialize managed files with their default content.
 * This is a synchronous function that returns a promise for the initialized files.
 */
export async function initializeManagedFiles(): Promise<ManagedFile[]> {
	const files: ManagedFile[] = []

	for (const fileName of ["AGENTS.md", "opencode.json", "TASK.md"]) {
		const content = await loadTemplateContent(fileName)
		files.push({
			name: fileName,
			defaultContent: content,
		})
	}

	return files
}

// This will be initialized by commands that need it
// For backward compatibility, export a variable that can be set
export let MANAGED_FILES: ManagedFile[] = []
