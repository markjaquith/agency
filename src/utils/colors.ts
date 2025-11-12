/**
 * Color highlighting utilities for CLI output
 *
 * This module provides centralized color management for highlighting
 * meaningful values in CLI feedback. All highlight types use the same
 * base color initially, but are separated into buckets to allow for
 * future customization.
 */

// ANSI color codes
const RESET = "\x1b[0m"
const CYAN_BRIGHT = "\x1b[96m"

/**
 * Central color configuration
 * All buckets use the same color initially (bright cyan)
 * but can be easily changed independently in the future
 */
const COLORS = {
	branch: CYAN_BRIGHT,
	template: CYAN_BRIGHT,
	file: CYAN_BRIGHT,
	setting: CYAN_BRIGHT,
	value: CYAN_BRIGHT,
	commit: CYAN_BRIGHT,
	pattern: CYAN_BRIGHT,
} as const

/**
 * Internal helper to apply color formatting
 */
function colorize(text: string, color: string): string {
	return `${color}${text}${RESET}`
}

/**
 * Highlight a branch name
 * @example highlight.branch("main") -> "\x1b[96mmain\x1b[0m"
 */
export function branch(name: string): string {
	return colorize(name, COLORS.branch)
}

/**
 * Highlight a template name
 * @example highlight.template("my-template") -> "\x1b[96mmy-template\x1b[0m"
 */
export function template(name: string): string {
	return colorize(name, COLORS.template)
}

/**
 * Highlight a file name or path
 * @example highlight.file("AGENTS.md") -> "\x1b[96mAGENTS.md\x1b[0m"
 */
export function file(name: string): string {
	return colorize(name, COLORS.file)
}

/**
 * Highlight a setting name
 * @example highlight.setting("agency.template") -> "\x1b[96magency.template\x1b[0m"
 */
export function setting(name: string): string {
	return colorize(name, COLORS.setting)
}

/**
 * Highlight a numeric value or count
 * @example highlight.value("3") -> "\x1b[96m3\x1b[0m"
 */
export function value(val: string | number): string {
	return colorize(String(val), COLORS.value)
}

/**
 * Highlight a commit hash
 * @example highlight.commit("abc123") -> "\x1b[96mabc123\x1b[0m"
 */
export function commit(hash: string): string {
	return colorize(hash, COLORS.commit)
}

/**
 * Highlight a pattern or placeholder
 * @example highlight.pattern("{task}") -> "\x1b[96m{task}\x1b[0m"
 */
export function pattern(text: string): string {
	return colorize(text, COLORS.pattern)
}

/**
 * Default export as namespace for convenient usage
 * @example import highlight from "./colors"
 * @example console.log(`Switched to ${highlight.branch("main")}`)
 */
export default {
	branch,
	template,
	file,
	setting,
	value,
	commit,
	pattern,
}
