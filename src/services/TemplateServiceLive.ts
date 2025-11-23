import { Effect, Layer } from "effect"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { TemplateService, TemplateError } from "./TemplateService"

const getConfigDir = () => {
	// Allow override for testing
	const env = process.env.AGENCY_CONFIG_DIR
	if (env && typeof env === "string") {
		return env
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
				return resolve(join(configDir, "templates", templateName))
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
			Effect.sync(() => {
				// Directory creation is handled by FileSystemService.createDirectory
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
