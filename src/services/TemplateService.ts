import { Effect, Data } from "effect"
import { join } from "node:path"
import {
	getAgencyConfigDir,
	getTemplateDir,
	getTemplatesDir,
} from "../utils/paths"

// Error types for Template operations
class TemplateError extends Data.TaggedError("TemplateError")<{
	message: string
	cause?: unknown
}> {}

// Template Service using Effect.Service pattern
export class TemplateService extends Effect.Service<TemplateService>()(
	"TemplateService",
	{
		sync: () => ({
			getConfigDir: () => Effect.sync(() => getAgencyConfigDir()),

			getTemplateDir: (templateName: string) =>
				Effect.sync(() => getTemplateDir(templateName)),

			templateExists: (templateName: string) =>
				Effect.tryPromise({
					try: async () => {
						const templateDir = getTemplateDir(templateName)
						const file = Bun.file(join(templateDir, "AGENTS.md"))
						return await file.exists()
					},
					catch: () =>
						new TemplateError({
							message: `Failed to check if template exists: ${templateName}`,
						}),
				}),

			createTemplateDir: (_templateName: string) =>
				Effect.sync(() => {
					// Directory creation is handled by FileSystemService.createDirectory
				}),

			listTemplates: () =>
				Effect.tryPromise({
					try: async () => {
						const templatesDir = getTemplatesDir()

						// Check if templates directory exists first
						const templatesFile = Bun.file(templatesDir)
						const exists = await templatesFile.exists()

						if (!exists) {
							// Return empty array if templates directory doesn't exist
							return [] as readonly string[]
						}

						const entries = await Array.fromAsync(
							new Bun.Glob("*/AGENTS.md").scan({ cwd: templatesDir }),
						)

						// Extract template names from paths like "work/AGENTS.md"
						const templates = entries
							.map((entry) => entry.split("/")[0] || "")
							.filter(Boolean)

						return templates as readonly string[]
					},
					catch: () =>
						new TemplateError({
							message: "Failed to list templates",
						}),
				}),
		}),
	},
) {}
