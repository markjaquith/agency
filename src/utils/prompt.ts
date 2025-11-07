import { createInterface } from "node:readline"

/**
 * Prompt the user for input
 */
export async function prompt(question: string): Promise<string> {
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
	})

	return new Promise((resolve) => {
		rl.question(question, (answer) => {
			rl.close()
			resolve(answer.trim())
		})
	})
}

/**
 * Sanitize a template name to be filesystem-safe
 */
export function sanitizeTemplateName(name: string): string {
	// Replace problematic characters with hyphens
	return name
		.replace(/[^a-zA-Z0-9_-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.toLowerCase()
}
