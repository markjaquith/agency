import { Effect, Data, pipe } from "effect"
import { spawnProcess } from "../utils/process"

// Error types for FilterRepo operations
class FilterRepoError extends Data.TaggedError("FilterRepoError")<{
	message: string
	cause?: unknown
}> {}

class FilterRepoNotInstalledError extends Data.TaggedError(
	"FilterRepoNotInstalledError",
)<{
	message: string
}> {}

/**
 * Service for git-filter-repo operations.
 * git-filter-repo is an external Python tool for rewriting git history.
 */
export class FilterRepoService extends Effect.Service<FilterRepoService>()(
	"FilterRepoService",
	{
		sync: () => ({
			/**
			 * Check if git-filter-repo is installed.
			 * @returns true if installed, false otherwise
			 */
			isInstalled: () =>
				pipe(
					spawnProcess(["which", "git-filter-repo"]),
					Effect.map((result) => result.exitCode === 0),
					Effect.catchAll(() => Effect.succeed(false)),
				),

			/**
			 * Run git-filter-repo with the given arguments.
			 * @param gitRoot - The git repository root
			 * @param args - Arguments to pass to git-filter-repo
			 * @param options - Additional options
			 * @returns Object with exitCode, stdout, stderr
			 */
			run: (
				gitRoot: string,
				args: readonly string[],
				options?: {
					readonly env?: Record<string, string>
				},
			) =>
				Effect.gen(function* () {
					// First check if git-filter-repo is installed
					const installed = yield* pipe(
						spawnProcess(["which", "git-filter-repo"]),
						Effect.map((result) => result.exitCode === 0),
						Effect.catchAll(() => Effect.succeed(false)),
					)

					if (!installed) {
						return yield* Effect.fail(
							new FilterRepoNotInstalledError({
								message:
									"git-filter-repo is not installed. Install it with: pip install git-filter-repo",
							}),
						)
					}

					const fullArgs = ["git-filter-repo", ...args]

					const result = yield* pipe(
						spawnProcess(fullArgs, {
							cwd: gitRoot,
							env: options?.env,
						}),
						Effect.mapError(
							(error) =>
								new FilterRepoError({
									message: `git-filter-repo failed: ${error.stderr}`,
									cause: error,
								}),
						),
					)

					if (result.exitCode !== 0) {
						return yield* Effect.fail(
							new FilterRepoError({
								message: `git-filter-repo failed with exit code ${result.exitCode}: ${result.stderr}`,
							}),
						)
					}

					return result
				}),

			/**
			 * Filter files from repository history.
			 * This is a higher-level operation that handles common filtering patterns.
			 * @param gitRoot - The git repository root
			 * @param options - Filtering options
			 */
			filterFiles: (
				gitRoot: string,
				options: {
					readonly refs?: string
					readonly pathsToRemove?: readonly string[]
					readonly pathRenames?: readonly { from: string; to: string }[]
					readonly force?: boolean
				},
			) =>
				Effect.gen(function* () {
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

					// Always use these safety options
					args.push("--prune-empty=always")

					const filterRepo = yield* FilterRepoService

					return yield* filterRepo.run(gitRoot, args, {
						env: { GIT_CONFIG_GLOBAL: "" },
					})
				}),
		}),
	},
) {}
