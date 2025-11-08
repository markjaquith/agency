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

/**
 * Prompt for base branch selection with smart defaults
 */
export async function promptForBaseBranch(
	suggestions: string[],
): Promise<string> {
	console.log("\nAvailable base branch options:")
	suggestions.forEach((branch, index) => {
		console.log(`  ${index + 1}. ${branch}`)
	})

	const answer = await prompt(
		`\nSelect base branch (1-${suggestions.length}) or enter custom branch name: `,
	)

	// Check if it's a number selection
	const selection = parseInt(answer, 10)
	if (!isNaN(selection) && selection >= 1 && selection <= suggestions.length) {
		const selected = suggestions[selection - 1]
		if (!selected) {
			throw new Error("Invalid selection")
		}
		return selected
	}

	// Otherwise treat as custom branch name
	return answer.trim()
}
