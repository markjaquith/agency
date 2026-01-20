/**
 * Utility functions for parsing and analyzing TASK.md files
 */

/**
 * Represents a task item parsed from markdown
 */
interface TaskItem {
	readonly text: string
	readonly isComplete: boolean
	readonly lineNumber: number
}

/**
 * Parse TASK.md content and extract task items
 * Returns all checkbox items (both complete and incomplete)
 */
export function parseTaskItems(content: string): TaskItem[] {
	const items: TaskItem[] = []
	const lines = content.split("\n")

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]
		if (!line) continue
		// Match both [ ] (incomplete) and [x] or [X] (complete)
		const match = line.match(/^[\s]*[-*]\s+\[([ xX])\]\s+(.+)$/)
		if (match && match[1] && match[2]) {
			const isComplete = match[1].toLowerCase() === "x"
			const text = match[2]
			items.push({
				text,
				isComplete,
				lineNumber: i + 1, // 1-indexed
			})
		}
	}

	return items
}

/**
 * Count completed and incomplete tasks
 */
export function countTasks(items: TaskItem[]): {
	completed: number
	incomplete: number
	total: number
} {
	const completed = items.filter((item) => item.isComplete).length
	const incomplete = items.filter((item) => !item.isComplete).length
	return {
		completed,
		incomplete,
		total: items.length,
	}
}

/**
 * Check if all tasks are complete
 */
export function areAllTasksComplete(items: TaskItem[]): boolean {
	if (items.length === 0) return true
	return items.every((item) => item.isComplete)
}

/**
 * Extract the promise completion message from output
 * Returns null if no completion message found
 */
export function extractCompletionPromise(output: string): string | null {
	const match = output.match(/<promise>([^<]+)<\/promise>/)
	return match && match[1] ? match[1] : null
}

/**
 * Validate that completion message aligns with task status
 * Throws an error if the agent claims completion but tasks remain
 */
export function validateCompletion(
	completionMessage: string | null,
	allTasksComplete: boolean,
): void {
	if (
		completionMessage &&
		completionMessage.toUpperCase() === "COMPLETE" &&
		!allTasksComplete
	) {
		throw new Error(
			"Agent claimed completion with <promise>COMPLETE</promise> but incomplete tasks remain in TASK.md. " +
				"This indicates the agent did not complete all work as required.",
		)
	}
}
