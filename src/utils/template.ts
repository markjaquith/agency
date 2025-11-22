import { Effect, pipe } from "effect"
import { TemplateService } from "../services/TemplateService"
import { TemplateServiceLive } from "../services/TemplateServiceLive"

/**
 * Helper function to run an Effect with the TemplateService
 * This provides backward compatibility with the existing async functions
 */
const runWithTemplateService = <A, E>(
	effect: Effect.Effect<A, E, TemplateService>,
) => Effect.runPromise(pipe(effect, Effect.provide(TemplateServiceLive)))

/**
 * Get the directory path for a template
 */
export function getTemplateDir(templateName: string): string {
	// Synchronous wrapper - get the config dir directly
	const { homedir } = require("node:os")
	const { join } = require("node:path")
	const configDir =
		process.env.AGENCY_CONFIG_DIR || join(homedir(), ".config", "agency")
	return join(configDir, "templates", templateName)
}

/**
 * Check if a template exists
 */
export async function templateExists(templateName: string): Promise<boolean> {
	try {
		return await runWithTemplateService(
			Effect.gen(function* () {
				const templateService = yield* TemplateService
				return yield* templateService.templateExists(templateName)
			}),
		)
	} catch {
		return false
	}
}

/**
 * Create a template directory
 */
export async function createTemplateDir(templateName: string): Promise<void> {
	await runWithTemplateService(
		Effect.gen(function* () {
			const templateService = yield* TemplateService
			yield* templateService.createTemplateDir(templateName)
		}),
	)
}

/**
 * List all available templates
 */
export async function listTemplates(): Promise<string[]> {
	try {
		return await runWithTemplateService(
			Effect.gen(function* () {
				const templateService = yield* TemplateService
				const templates = yield* templateService.listTemplates()
				return Array.from(templates)
			}),
		)
	} catch {
		return []
	}
}
