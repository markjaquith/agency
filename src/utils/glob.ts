/**
 * Utilities for glob pattern matching and expansion.
 * Uses Bun's built-in Glob API.
 */

/**
 * Check if a string contains glob pattern characters.
 * This detects wildcards like *, **, ?, and character classes like [abc].
 */
export function isGlobPattern(str: string): boolean {
	return /[*?[\]]/.test(str)
}

/**
 * Check if a path matches a glob pattern.
 * Uses Bun.Glob for pattern matching.
 */
export function matchesGlob(pattern: string, path: string): boolean {
	const glob = new Bun.Glob(pattern)
	return glob.match(path)
}

/**
 * Expand glob patterns to actual file paths.
 * Non-glob paths are returned as-is.
 *
 * @param patterns - Array of file paths or glob patterns
 * @param cwd - Working directory to resolve patterns against
 * @returns Array of expanded file paths (deduplicated)
 */
export async function expandGlobs(
	patterns: string[],
	cwd: string,
): Promise<string[]> {
	const files = new Set<string>()

	for (const pattern of patterns) {
		if (isGlobPattern(pattern)) {
			// Expand glob pattern
			const glob = new Bun.Glob(pattern)
			for await (const file of glob.scan({ cwd })) {
				files.add(file)
			}
		} else {
			// Non-glob path, add as-is
			files.add(pattern)
		}
	}

	return Array.from(files)
}

/**
 * Convert a directory path to a glob pattern.
 * Appends /** to match all files recursively in the directory.
 *
 * @param dirPath - Directory path (e.g., "plans" or "plans/")
 * @returns Glob pattern (e.g., "plans/**")
 */
export function dirToGlobPattern(dirPath: string): string {
	// Remove trailing slash if present
	const normalized = dirPath.replace(/\/+$/, "")
	return `${normalized}/**`
}

/**
 * Extract the top-level directory from a file path.
 *
 * @param filePath - File path (e.g., "plans/foo/bar.md")
 * @returns Top-level directory name (e.g., "plans") or null if no directory
 */
export function getTopLevelDir(filePath: string): string | null {
	const parts = filePath.split("/")
	if (parts.length > 1) {
		return parts[0] || null
	}
	return null
}
