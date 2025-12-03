import { join } from "node:path"
import { Schema } from "@effect/schema"
import { ManagedFile, AgencyMetadata } from "./schemas"

export interface Command {
	name: string
	description: string
	run: (args: string[], options: Record<string, any>) => Promise<void>
	help?: string
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
		"AGENCY.md": `# Agent Instructions

## TASK.md

The \`TASK.md\` file describes the task being performed and should be kept updated as work progresses. This file serves as a living record of:

- What is being built or fixed
- Current progress and status
- Remaining work items
- Any important context or decisions

All work on this repository should begin by reading and understanding \`TASK.md\`. Whenever any significant progress is made, \`TASK.md\` should be updated to reflect the current state of work.

See \`TASK.md\` for the current task description and progress.
`,
		"AGENTS.md": `# Agency

Agency is a CLI tool for managing \`AGENTS.md\`, \`TASK.md\`, and \`opencode.json\` files in git repositories. It helps coordinate work across multiple branches and templates.

## Key Commands

- \`agency task\` - Initialize template files on a feature branch
- \`agency edit\` - Open TASK.md in system editor
- \`agency template save\` - Save current file versions back to a template
- \`agency template use\` - Switch to a different template
- \`agency emit\` - Create a PR branch with managed files reverted to their merge-base state
- \`agency switch\` - Toggle between feature and PR branches
- \`agency template source\` - Get the path to a template's source directory
- \`agency set-base\` - Update the saved base branch for PR creation

## Features

- **Template-based workflow** - Reusable templates stored in \`~/.config/agency/templates/\`
- **Git integration** - Saves template configuration in \`.git/config\`
- **PR branch management** - Automatically creates clean PR branches without local modifications
- **Multi-file support** - Manages AGENTS.md, TASK.md, and opencode.json
`,
		"TASK.md": `{task}

## Tasks

- [ ] Populate this list
`,
		"opencode.json": JSON.stringify(
			{
				$schema: "https://opencode.ai/config.json",
				instructions: ["AGENCY.md", "TASK.md"],
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

	for (const fileName of [
		"AGENCY.md",
		"AGENTS.md",
		"opencode.json",
		"TASK.md",
	]) {
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
let MANAGED_FILES: ManagedFile[] = []

// Validation is now handled by Effect schemas in schemas.ts

/**
 * Read agency.json metadata from a repository.
 */
export async function readAgencyMetadata(
	gitRoot: string,
): Promise<AgencyMetadata | null> {
	const metadataPath = join(gitRoot, "agency.json")
	const file = Bun.file(metadataPath)

	if (!(await file.exists())) {
		return null
	}

	try {
		const data = await file.json()

		// Validate version field exists
		if (typeof data.version !== "number") {
			throw new Error(
				`Invalid agency.json: missing or invalid 'version' field. Expected a number.`,
			)
		}

		// Check for supported version
		if (data.version !== 1) {
			throw new Error(
				`Unsupported agency.json version: ${data.version}. This version of Agency only supports version 1.`,
			)
		}

		// Parse and validate using Effect schema
		try {
			return Schema.decodeUnknownSync(AgencyMetadata)(data)
		} catch (schemaError) {
			throw new Error(
				`Invalid agency.json format: ${schemaError instanceof Error ? schemaError.message : String(schemaError)}`,
			)
		}
	} catch (error) {
		if (error instanceof Error) {
			throw error
		}
		throw new Error(`Failed to parse agency.json: ${error}`)
	}
}

/**
 * Write agency.json metadata to a repository.
 */
export async function writeAgencyMetadata(
	gitRoot: string,
	metadata: AgencyMetadata,
): Promise<void> {
	const metadataPath = join(gitRoot, "agency.json")
	await Bun.write(metadataPath, JSON.stringify(metadata, null, 2) + "\n")
}

/**
 * Get list of files to filter during PR/merge operations.
 * Always includes TASK.md, AGENCY.md, and agency.json, plus any backpack files from metadata.
 */
export async function getFilesToFilter(gitRoot: string): Promise<string[]> {
	const metadata = await readAgencyMetadata(gitRoot)
	const baseFiles = ["TASK.md", "AGENCY.md", "agency.json"]

	if (!metadata) {
		// Fallback to just the base files if no metadata exists
		return baseFiles
	}

	return [...baseFiles, ...metadata.injectedFiles]
}

/**
 * Get the configured base branch from agency.json metadata.
 */
export async function getBaseBranchFromMetadata(
	gitRoot: string,
): Promise<string | null> {
	const metadata = await readAgencyMetadata(gitRoot)
	return metadata?.baseBranch || null
}

/**
 * Set the base branch in agency.json metadata.
 */
export async function setBaseBranchInMetadata(
	gitRoot: string,
	baseBranch: string,
): Promise<void> {
	const metadata = await readAgencyMetadata(gitRoot)
	if (!metadata) {
		throw new Error(
			"agency.json not found. Please run 'agency task' first to initialize backpack files.",
		)
	}

	// Create a new metadata instance with the updated baseBranch
	const updatedMetadata = new AgencyMetadata({
		version: metadata.version,
		injectedFiles: metadata.injectedFiles,
		template: metadata.template,
		createdAt: metadata.createdAt,
		baseBranch,
	})
	await writeAgencyMetadata(gitRoot, updatedMetadata)
}
