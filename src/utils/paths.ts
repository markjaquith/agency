/**
 * Utilities for resolving agency configuration paths.
 */

import { homedir } from "node:os"
import { join } from "node:path"

/**
 * Get the agency configuration directory.
 * Defaults to ~/.config/agency, can be overridden via AGENCY_CONFIG_DIR env var.
 * @param override - Optional override for the config directory (used in testing)
 */
export function getAgencyConfigDir(override?: string): string {
	return (
		override ||
		process.env.AGENCY_CONFIG_DIR ||
		join(homedir(), ".config", "agency")
	)
}

/**
 * Get the path to the agency config file (agency.json).
 * Can be overridden via AGENCY_CONFIG_PATH env var.
 * @param configDir - Optional config directory override
 */
export function getAgencyConfigPath(configDir?: string): string {
	return (
		process.env.AGENCY_CONFIG_PATH ||
		join(getAgencyConfigDir(configDir), "agency.json")
	)
}

/**
 * Get the templates directory path.
 * @param configDir - Optional config directory override
 */
export function getTemplatesDir(configDir?: string): string {
	return join(getAgencyConfigDir(configDir), "templates")
}

/**
 * Get the path to a specific template directory.
 * @param templateName - Name of the template
 * @param configDir - Optional config directory override
 */
export function getTemplateDir(
	templateName: string,
	configDir?: string,
): string {
	return join(getTemplatesDir(configDir), templateName)
}
