import { Effect, Layer } from "effect"
import { homedir } from "node:os"
import { join } from "node:path"
import { mkdir } from "node:fs/promises"
import { TemplateService, TemplateError } from "./TemplateService"

const getConfigDir = () => {
	// Allow override for testing
	if (process.env.AGENCY_CONFIG_DIR) {
		return process.env.AGENCY_CONFIG_DIR
	}
	return join(homedir(), ".config", "agency")
}

export const TemplateServiceLive = Layer.succeed(
	TemplateService,
	TemplateService.of({
		getConfigDir: () => Effect.sync(() => getConfigDir()),

		getTemplateDir: (templateName: string) =>
			Effect.sync(() => {
				const configDir = getConfigDir()
				return join(configDir, "templates", templateName)
			}),

		templateExists: (templateName: string) =>
			Effect.tryPromise({
				try: async () => {
					const configDir = getConfigDir()
					const templateDir = join(configDir, "templates", templateName)
					const file = Bun.file(join(templateDir, "AGENTS.md"))
					return await file.exists()
				},
				catch: () =>
					new TemplateError({
						message: `Failed to check if template exists: ${templateName}`,
					}),
			}),

		createTemplateDir: (templateName: string) =>
			Effect.tryPromise({
				try: async () => {
					const configDir = getConfigDir()
					const templateDir = join(configDir, "templates", templateName)
					await mkdir(templateDir, { recursive: true })
				},
				catch: (error) =>
					new TemplateError({
						message: `Failed to create template directory: ${templateName}`,
						cause: error,
					}),
			}),

		listTemplates: () =>
			Effect.tryPromise({
				try: async () => {
					const configDir = getConfigDir()
					const templatesDir = join(configDir, "templates")

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
)
