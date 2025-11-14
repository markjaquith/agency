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

export interface AgencyMetadata {
	version: number
	injectedFiles: string[]
	baseBranch?: string
	template: string
	createdAt: string
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
		"AGENCY.md": `# Agency

Agency is a CLI tool for managing \`AGENTS.md\`, \`TASK.md\`, and \`opencode.json\` files in git repositories. It helps coordinate work across multiple branches and templates.

## Key Commands

- \`agency task\` - Initialize template files on a feature branch
- \`agency edit\` - Open TASK.md in system editor
- \`agency template save\` - Save current file versions back to a template
- \`agency template use\` - Switch to a different template
- \`agency pr\` - Create a PR branch with managed files reverted to their merge-base state
- \`agency switch\` - Toggle between feature and PR branches
- \`agency template source\` - Get the path to a template's source directory
- \`agency set-base\` - Update the saved base branch for PR creation

## Features

- **Template-based workflow** - Reusable templates stored in \`~/.config/agency/templates/\`
- **Git integration** - Saves template configuration in \`.git/config\`
- **PR branch management** - Automatically creates clean PR branches without local modifications
- **Multi-file support** - Manages AGENTS.md, TASK.md, and opencode.json
`,
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
export let MANAGED_FILES: ManagedFile[] = []

/**
 * JSON Schema for agency.json version 1
 */
const AGENCY_METADATA_SCHEMA_V1 = {
	type: "object",
	required: ["version", "injectedFiles", "template", "createdAt"],
	properties: {
		version: {
			type: "number",
			const: 1,
		},
		injectedFiles: {
			type: "array",
			items: {
				type: "string",
			},
		},
		baseBranch: {
			type: "string",
		},
		template: {
			type: "string",
		},
		createdAt: {
			type: "string",
			format: "date-time",
		},
	},
	additionalProperties: false,
}

/**
 * Validate data against a JSON schema
 */
function validateSchema(
	data: any,
	schema: any,
): { valid: boolean; errors: string[] } {
	const errors: string[] = []

	// Check required fields
	if (schema.required) {
		for (const field of schema.required) {
			if (!(field in data)) {
				errors.push(`Missing required field: ${field}`)
			}
		}
	}

	// Check properties
	if (schema.properties) {
		for (const [key, propSchema] of Object.entries(schema.properties)) {
			const value = data[key]
			if (value === undefined) continue

			const prop = propSchema as any

			// Type check
			if (prop.type) {
				const actualType = Array.isArray(value) ? "array" : typeof value
				if (actualType !== prop.type) {
					errors.push(
						`Field '${key}' should be type '${prop.type}', got '${actualType}'`,
					)
				}
			}

			// Const check
			if (prop.const !== undefined && value !== prop.const) {
				errors.push(`Field '${key}' should be ${prop.const}, got ${value}`)
			}

			// Array items check
			if (prop.type === "array" && prop.items && Array.isArray(value)) {
				for (let i = 0; i < value.length; i++) {
					const itemType = typeof value[i]
					if (itemType !== prop.items.type) {
						errors.push(
							`Field '${key}[${i}]' should be type '${prop.items.type}', got '${itemType}'`,
						)
					}
				}
			}
		}
	}

	// Check for additional properties
	if (schema.additionalProperties === false) {
		const allowedKeys = new Set(Object.keys(schema.properties || {}))
		for (const key of Object.keys(data)) {
			if (!allowedKeys.has(key)) {
				errors.push(`Unknown field: ${key}`)
			}
		}
	}

	return { valid: errors.length === 0, errors }
}

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

		// Validate against schema
		const validation = validateSchema(data, AGENCY_METADATA_SCHEMA_V1)
		if (!validation.valid) {
			throw new Error(
				`Invalid agency.json format:\n${validation.errors.map((e) => `  - ${e}`).join("\n")}`,
			)
		}

		return data as AgencyMetadata
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
 * Always includes TASK.md and agency.json, plus any injected files from metadata.
 */
export async function getFilesToFilter(gitRoot: string): Promise<string[]> {
	const metadata = await readAgencyMetadata(gitRoot)
	const baseFiles = ["TASK.md", "agency.json"]

	if (!metadata) {
		// Fallback to just the base files if no metadata exists
		return baseFiles
	}

	return [...baseFiles, ...metadata.injectedFiles]
}
