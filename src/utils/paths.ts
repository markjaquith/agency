/**
 * Utilities for resolving agency configuration paths.
 */

import { homedir } from "node:os"
import { join } from "node:path"

/**
 * Get the agency configuration directory.
 * Defaults to ~/.config/agency, can be overridden via AGENCY_CONFIG_DIR env var.
 */
export function getAgencyConfigDir(): string {
	return process.env.AGENCY_CONFIG_DIR || join(homedir(), ".config", "agency")
}

/**
 * Get the path to the agency config file (agency.json).
 * Can be overridden via AGENCY_CONFIG_PATH env var.
 */
export function getAgencyConfigPath(): string {
	return (
		process.env.AGENCY_CONFIG_PATH || join(getAgencyConfigDir(), "agency.json")
	)
}

/**
 * Get the templates directory path.
 */
export function getTemplatesDir(): string {
	return join(getAgencyConfigDir(), "templates")
}

/**
 * Get the path to a specific template directory.
 */
export function getTemplateDir(templateName: string): string {
	return join(getTemplatesDir(), templateName)
}
