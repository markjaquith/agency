import { join } from "node:path"
import { Effect } from "effect"
import { Schema } from "@effect/schema"
import { ManagedFile, AgencyMetadata } from "./schemas"
import { AgencyMetadataService } from "./services/AgencyMetadataService"
import { FileSystemService } from "./services/FileSystemService"
import { GitService } from "./services/GitService"

export interface Command {
	name: string
	description: string
	run: (
		args: string[],
		options: Record<string, any>,
		rawArgs?: string[],
	) => Promise<void>
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

- \`agency task <branch-name>\` - Create feature branch and initialize template files
- \`agency edit\` - Open TASK.md in system editor
- \`agency template save\` - Save current file versions back to a template
- \`agency template use\` - Switch to a different template
- \`agency emit\` - Create an emit branch with managed files reverted to their merge-base state
- \`agency switch\` - Toggle between feature and emit branches
- \`agency template source\` - Get the path to a template's source directory
- \`agency set-base\` - Update the saved base branch for emit creation

## Features

- **Template-based workflow** - Reusable templates stored in \`~/.config/agency/templates/\`
- **Git integration** - Saves template configuration in \`.git/config\`
- **Emit branch management** - Automatically creates clean emit branches without local modifications
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
 * @deprecated Use AgencyMetadataService.readFromDisk instead
 */
export async function readAgencyMetadata(
	gitRoot: string,
): Promise<AgencyMetadata | null> {
	const program = Effect.gen(function* () {
		const metadataService = yield* AgencyMetadataService
		return yield* metadataService.readFromDisk(gitRoot)
	}).pipe(
		Effect.provide(AgencyMetadataService.Default),
		Effect.provide(FileSystemService.Default),
		Effect.provide(GitService.Default),
	)

	return Effect.runPromise(program)
}

/**
 * Write agency.json metadata to a repository.
 * @deprecated Use AgencyMetadataService.write instead
 */
export async function writeAgencyMetadata(
	gitRoot: string,
	metadata: AgencyMetadata,
): Promise<void> {
	const program = Effect.gen(function* () {
		const metadataService = yield* AgencyMetadataService
		return yield* metadataService.write(gitRoot, metadata)
	}).pipe(
		Effect.provide(AgencyMetadataService.Default),
		Effect.provide(FileSystemService.Default),
		Effect.provide(GitService.Default),
	)

	return Effect.runPromise(program)
}

/**
 * Get list of files to filter during PR/merge operations.
 * Always includes TASK.md, AGENCY.md, CLAUDE.md, and agency.json, plus any backpack files from metadata.
 * @deprecated Use AgencyMetadataService.getFilesToFilter instead
 */
export async function getFilesToFilter(gitRoot: string): Promise<string[]> {
	const program = Effect.gen(function* () {
		const metadataService = yield* AgencyMetadataService
		return yield* metadataService.getFilesToFilter(gitRoot)
	}).pipe(
		Effect.provide(AgencyMetadataService.Default),
		Effect.provide(FileSystemService.Default),
		Effect.provide(GitService.Default),
	)

	return Effect.runPromise(program)
}

/**
 * Get the configured base branch from agency.json metadata.
 * @deprecated Use AgencyMetadataService.getBaseBranch instead
 */
export async function getBaseBranchFromMetadata(
	gitRoot: string,
): Promise<string | null> {
	const program = Effect.gen(function* () {
		const metadataService = yield* AgencyMetadataService
		return yield* metadataService.getBaseBranch(gitRoot)
	}).pipe(
		Effect.provide(AgencyMetadataService.Default),
		Effect.provide(FileSystemService.Default),
		Effect.provide(GitService.Default),
	)

	return Effect.runPromise(program)
}

/**
 * Set the base branch in agency.json metadata.
 * @deprecated Use AgencyMetadataService.setBaseBranch instead
 */
export async function setBaseBranchInMetadata(
	gitRoot: string,
	baseBranch: string,
): Promise<void> {
	const program = Effect.gen(function* () {
		const metadataService = yield* AgencyMetadataService
		return yield* metadataService.setBaseBranch(gitRoot, baseBranch)
	}).pipe(
		Effect.provide(AgencyMetadataService.Default),
		Effect.provide(FileSystemService.Default),
		Effect.provide(GitService.Default),
	)

	return Effect.runPromise(program)
}
