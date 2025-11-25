import { Effect, Data } from "effect"
import { createInterface } from "node:readline"
import highlight from "../utils/colors"

// Error types for Prompt operations
class PromptError extends Data.TaggedError("PromptError")<{
	message: string
	cause?: unknown
}> {}

// Prompt Service using Effect.Service pattern
export class PromptService extends Effect.Service<PromptService>()(
	"PromptService",
	{
		sync: () => ({
			prompt: (question: string, defaultValue?: string) =>
				Effect.tryPromise({
					try: () =>
						new Promise<string>((resolve) => {
							const rl = createInterface({
								input: process.stdin,
								output: process.stdout,
							})

							rl.question(question, (answer) => {
								rl.close()
								resolve(answer.trim())
							})

							// If a default value is provided, pre-fill it in the prompt
							// This allows the user to backspace and delete it
							if (defaultValue) {
								rl.write(defaultValue)
							}
						}),
					catch: (error) =>
						new PromptError({
							message: "Failed to prompt user for input",
							cause: error,
						}),
				}),

			promptForSelection: (message: string, options: readonly string[]) =>
				Effect.tryPromise({
					try: () =>
						new Promise<string>((resolve, reject) => {
							console.log(message)
							options.forEach((option, index) => {
								console.log(`  ${index + 1}. ${option}`)
							})

							const rl = createInterface({
								input: process.stdin,
								output: process.stdout,
							})

							rl.question(
								`\nSelect option (1-${options.length}) or enter custom value: `,
								(answer) => {
									rl.close()

									// Check if it's a number selection
									const selection = parseInt(answer, 10)
									if (
										!isNaN(selection) &&
										selection >= 1 &&
										selection <= options.length
									) {
										const selected = options[selection - 1]
										if (selected === undefined) {
											reject(new Error("Invalid selection"))
											return
										}
										resolve(selected)
										return
									}

									// Otherwise treat as custom value
									resolve(answer.trim())
								},
							)
						}),
					catch: (error) =>
						new PromptError({
							message: "Failed to prompt user for selection",
							cause: error,
						}),
				}),

			sanitizeTemplateName: (name: string) =>
				Effect.sync(() => {
					// Replace problematic characters with hyphens
					return name
						.replace(/[^a-zA-Z0-9_-]/g, "-")
						.replace(/-+/g, "-")
						.replace(/^-|-$/g, "")
						.toLowerCase()
				}),

			/**
			 * Prompt user to select a template from a list.
			 * Returns the selected template name or a new name entered by user.
			 */
			promptForTemplate: (
				templates: readonly string[],
				options?: {
					readonly currentTemplate?: string
					readonly defaultValue?: string
					readonly allowNew?: boolean
				},
			) =>
				Effect.tryPromise({
					try: () =>
						new Promise<string>((resolve, reject) => {
							const {
								currentTemplate,
								defaultValue,
								allowNew = true,
							} = options ?? {}

							// Display template list
							if (templates.length > 0) {
								console.log("\nAvailable templates:")
								templates.forEach((t, i) => {
									const current = t === currentTemplate ? " (current)" : ""
									console.log(
										`  ${highlight.value(i + 1)}. ${highlight.template(t)}${current}`,
									)
								})
								console.log("")
							}

							const rl = createInterface({
								input: process.stdin,
								output: process.stdout,
							})

							const promptText =
								templates.length > 0
									? allowNew
										? `Template name (1-${templates.length}) or enter new name: `
										: `Template name (or number): `
									: "Template name: "

							rl.question(promptText, (answer) => {
								rl.close()

								const trimmed = answer.trim()
								if (!trimmed) {
									reject(new Error("Template name is required."))
									return
								}

								// Check if answer is a number (template selection)
								const num = parseInt(trimmed, 10)
								if (!isNaN(num) && num >= 1 && num <= templates.length) {
									const selected = templates[num - 1]
									if (!selected) {
										reject(new Error("Invalid selection"))
										return
									}
									resolve(selected)
									return
								}

								// Otherwise treat as template name
								resolve(trimmed)
							})

							// Pre-fill default value if provided
							if (defaultValue) {
								rl.write(defaultValue)
							}
						}),
					catch: (error) =>
						new PromptError({
							message: "Failed to prompt user for template selection",
							cause: error,
						}),
				}),
		}),
	},
) {}
