import { Effect, Layer } from "effect"
import { FilterRepoService } from "./FilterRepoService"

/**
 * Captured filter-repo call for verification in tests.
 */
export interface CapturedFilterRepoCall {
	gitRoot: string
	args: readonly string[]
	env?: Record<string, string>
}

/**
 * Global state for captured filter-repo calls.
 * Tests can inspect this to verify correct commands were constructed.
 */
let capturedCalls: CapturedFilterRepoCall[] = []

/**
 * Clear all captured filter-repo calls.
 * Call this in beforeEach() to reset state between tests.
 */
export function clearCapturedFilterRepoCalls(): void {
	capturedCalls = []
}

/**
 * Get all captured filter-repo calls.
 * @returns Array of captured calls
 */
export function getCapturedFilterRepoCalls(): readonly CapturedFilterRepoCall[] {
	return capturedCalls
}

/**
 * Get the last captured filter-repo call.
 * @returns The last captured call, or undefined if none
 */
export function getLastCapturedFilterRepoCall():
	| CapturedFilterRepoCall
	| undefined {
	return capturedCalls[capturedCalls.length - 1]
}

/**
 * Mock implementation of FilterRepoService.
 *
 * This mock:
 * - Always returns true for isInstalled()
 * - Captures the arguments passed to run() without executing
 * - Returns a successful result with exit code 0
 *
 * Use getCapturedFilterRepoCalls() to verify the correct commands were constructed.
 */
export class MockFilterRepoService extends Effect.Service<MockFilterRepoService>()(
	"FilterRepoService", // Same tag as the real service to replace it
	{
		sync: () => ({
			isInstalled: () => Effect.succeed(true),

			run: (
				gitRoot: string,
				args: readonly string[],
				options?: {
					readonly env?: Record<string, string>
				},
			) => {
				// Capture the call
				capturedCalls.push({
					gitRoot,
					args,
					env: options?.env,
				})

				// Return a successful result
				return Effect.succeed({
					exitCode: 0,
					stdout: "",
					stderr: "",
				})
			},

			filterFiles: (
				gitRoot: string,
				options: {
					readonly refs?: string
					readonly pathsToRemove?: readonly string[]
					readonly pathRenames?: readonly { from: string; to: string }[]
					readonly force?: boolean
				},
			) => {
				// Build the args like the real implementation would
				const args: string[] = []

				if (options.refs) {
					args.push("--refs", options.refs)
				}

				if (options.pathsToRemove) {
					for (const path of options.pathsToRemove) {
						args.push("--invert-paths", "--path", path)
					}
				}

				if (options.pathRenames) {
					for (const rename of options.pathRenames) {
						args.push("--path-rename", `${rename.from}:${rename.to}`)
					}
				}

				if (options.force) {
					args.push("--force")
				}

				args.push("--prune-empty=always")

				// Capture the call
				capturedCalls.push({
					gitRoot,
					args,
					env: { GIT_CONFIG_GLOBAL: "" },
				})

				// Return a successful result
				return Effect.succeed({
					exitCode: 0,
					stdout: "",
					stderr: "",
				})
			},
		}),
	},
) {}
