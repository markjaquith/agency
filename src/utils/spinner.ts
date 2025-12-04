import ora from "ora"
import { Effect } from "effect"

/**
 * Configuration for a spinner operation
 */
interface SpinnerConfig {
	/** The message to show while the spinner is running */
	text: string
	/** The message to show when the operation succeeds */
	successText?: string
	/** The message to show when the operation fails */
	failText?: string
	/** Whether the spinner is enabled (defaults to true) */
	enabled?: boolean
}

/**
 * Wraps an Effect operation with a spinner that shows progress
 * and updates with success/failure messages.
 *
 * @param effect The Effect operation to run
 * @param config Configuration for the spinner
 * @returns The result of the Effect operation
 *
 * @example
 * ```ts
 * const result = yield* withSpinner(
 *   someOperation(),
 *   {
 *     text: "Processing...",
 *     successText: "Processing complete",
 *     failText: "Processing failed"
 *   }
 * )
 * ```
 */
export const withSpinner = <A, E, R>(
	effect: Effect.Effect<A, E, R>,
	config: SpinnerConfig,
): Effect.Effect<A, E, R> => {
	const { text, successText, failText, enabled = true } = config

	if (!enabled) {
		return effect
	}

	return Effect.gen(function* () {
		const spinner = ora({
			text,
			spinner: "dots",
			color: "cyan",
		}).start()

		try {
			const result = yield* effect

			if (successText) {
				spinner.succeed(successText)
			} else {
				spinner.stop()
			}

			return result
		} catch (error) {
			if (failText) {
				spinner.fail(failText)
			} else {
				spinner.stop()
			}
			throw error
		}
	})
}
