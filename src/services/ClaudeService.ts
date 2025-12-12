import { Effect } from "effect"
import { FileSystemService } from "./FileSystemService"

const AGENCY_SECTION = `
## Agency

@AGENCY.md
@TASK.md`

/**
 * Service for handling CLAUDE.md files with @-reference injection.
 */
export class ClaudeService extends Effect.Service<ClaudeService>()(
	"ClaudeService",
	{
		sync: () => ({
			/**
			 * Check if CLAUDE.md exists in the git root.
			 */
			claudeFileExists: (gitRoot: string) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const claudePath = `${gitRoot}/CLAUDE.md`
					return yield* fs.exists(claudePath)
				}),

			/**
			 * Check if the CLAUDE.md file already contains the agency section.
			 */
			hasAgencySection: (content: string) =>
				Effect.sync(() => {
					// Check if both @AGENCY.md and @TASK.md exist in the content
					return content.includes("@AGENCY.md") && content.includes("@TASK.md")
				}),

			/**
			 * Inject or ensure the agency section exists in CLAUDE.md.
			 * If the file doesn't exist, create it with the basic template.
			 * If it exists but doesn't have the references, append them.
			 * Returns true if the file was modified, false if no changes needed.
			 */
			injectAgencySection: (gitRoot: string) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const claudePath = `${gitRoot}/CLAUDE.md`

					// Check if file exists
					const exists = yield* fs.exists(claudePath)

					if (!exists) {
						// Create new CLAUDE.md with basic template
						const content = `# Claude Code Instructions

This project uses the agency CLI for managing development tasks and templates.
${AGENCY_SECTION}
`
						yield* fs.writeFile(claudePath, content)
						return { modified: true, created: true }
					}

					// Read existing content
					const content = yield* fs.readFile(claudePath)

					// Check if agency section already exists
					const hasSection = yield* Effect.sync(() => {
						return (
							content.includes("@AGENCY.md") && content.includes("@TASK.md")
						)
					})

					if (hasSection) {
						// Check if they're in the correct order
						const agencyIndex = content.indexOf("@AGENCY.md")
						const taskIndex = content.indexOf("@TASK.md")

						if (agencyIndex < taskIndex) {
							// Already has the section in correct order
							return { modified: false, created: false }
						}

						// They exist but in wrong order - we'll re-add them
					}

					// Append the agency section
					const newContent = content.trimEnd() + "\n" + AGENCY_SECTION + "\n"
					yield* fs.writeFile(claudePath, newContent)
					return { modified: true, created: false }
				}),
		}),
	},
) {}
