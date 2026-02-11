import { Effect } from "effect"
import { resolve } from "path"
import { FileSystemService } from "./FileSystemService"

type PackageJson = {
	dependencies?: Record<string, string>
	devDependencies?: Record<string, string>
}

type PackageManager = "bun" | "yarn" | "pnpm" | "npm"

type Formatter = "prettier" | "oxfmt"

/**
 * Service for detecting and running code formatters on agency-created files.
 *
 * When agency creates files (markdown, json), pre-commit or pre-push hooks
 * in the target project may fail if those files aren't formatted according
 * to the project's formatter settings. This service detects the project's
 * formatter (prettier or oxfmt) and package manager, then runs the formatter
 * on the specified files. Failures are silently ignored.
 */
export class FormatterService extends Effect.Service<FormatterService>()(
	"FormatterService",
	{
		sync: () => ({
			/**
			 * Detect which package manager the project uses by checking for lock files.
			 * Falls back to npm if no lock file is found but package.json exists.
			 * Returns null if no package.json exists.
			 */
			detectPackageManager: (gitRoot: string) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService

					// Check for package.json first - if it doesn't exist, no package manager
					const hasPackageJson = yield* fs.exists(
						resolve(gitRoot, "package.json"),
					)
					if (!hasPackageJson) {
						return null
					}

					// Check lock files in priority order
					if (yield* fs.exists(resolve(gitRoot, "bun.lockb")))
						return "bun" as PackageManager
					if (yield* fs.exists(resolve(gitRoot, "bun.lock")))
						return "bun" as PackageManager
					if (yield* fs.exists(resolve(gitRoot, "yarn.lock")))
						return "yarn" as PackageManager
					if (yield* fs.exists(resolve(gitRoot, "pnpm-lock.yaml")))
						return "pnpm" as PackageManager
					if (yield* fs.exists(resolve(gitRoot, "package-lock.json")))
						return "npm" as PackageManager

					// Default to npm if package.json exists but no lock file found
					return "npm" as PackageManager
				}),

			/**
			 * Detect which formatter is available in the project's package.json.
			 * Checks both dependencies and devDependencies for prettier and oxfmt.
			 * Returns null if neither is found.
			 */
			detectFormatter: (gitRoot: string) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService

					const packageJsonPath = resolve(gitRoot, "package.json")
					const exists = yield* fs.exists(packageJsonPath)
					if (!exists) {
						return null
					}

					const packageJson = yield* fs.readJSON<PackageJson>(packageJsonPath)

					const allDeps = {
						...packageJson.dependencies,
						...packageJson.devDependencies,
					}

					// Check for oxfmt first (newer/faster), then prettier
					if ("oxfmt" in allDeps) return "oxfmt" as Formatter
					if ("prettier" in allDeps) return "prettier" as Formatter

					return null
				}).pipe(Effect.catchAll(() => Effect.succeed(null))),

			/**
			 * Build the command to run a formatter via the detected package manager.
			 * Returns the command args array, or null if the formatter/pm combo isn't supported.
			 */
			buildFormatterCommand: (
				formatter: Formatter,
				packageManager: PackageManager,
				files: string[],
			) =>
				Effect.sync(() => {
					if (files.length === 0) return null

					// Build the runner prefix based on package manager
					const runnerPrefix: string[] = (() => {
						switch (packageManager) {
							case "bun":
								return ["bun", "x"]
							case "yarn":
								return ["yarn", "dlx"]
							case "pnpm":
								return ["pnpm", "exec"]
							case "npm":
								return ["npx"]
						}
					})()

					// Build the formatter command
					switch (formatter) {
						case "prettier":
							return [...runnerPrefix, "prettier", "--write", ...files]
						case "oxfmt":
							return [...runnerPrefix, "oxfmt", ...files]
						default:
							return null
					}
				}),

			/**
			 * Format the given files using the project's detected formatter.
			 * Silently returns if no formatter is detected or if the command fails.
			 * This is the main entry point for formatting agency-created files.
			 */
			formatFiles: (
				gitRoot: string,
				files: string[],
				verboseLog: (msg: string) => void,
			) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService

					if (files.length === 0) {
						verboseLog("No files to format")
						return
					}

					// Filter to only .md and .json/.jsonc files (the types agency creates)
					const formattableFiles = files.filter(
						(f) =>
							f.endsWith(".md") || f.endsWith(".json") || f.endsWith(".jsonc"),
					)

					if (formattableFiles.length === 0) {
						verboseLog("No formattable files (md/json/jsonc) found")
						return
					}

					// Use yield* on the service methods via self-reference through the service tag
					const formatterService = yield* FormatterService

					const formatter = yield* formatterService.detectFormatter(gitRoot)
					if (!formatter) {
						verboseLog("No formatter (prettier/oxfmt) detected in package.json")
						return
					}

					const packageManager =
						yield* formatterService.detectPackageManager(gitRoot)
					if (!packageManager) {
						verboseLog("No package manager detected")
						return
					}

					verboseLog(
						`Detected formatter: ${formatter}, package manager: ${packageManager}`,
					)

					// Build absolute paths for the files
					const absolutePaths = formattableFiles.map((f) => resolve(gitRoot, f))

					const command = yield* formatterService.buildFormatterCommand(
						formatter,
						packageManager,
						absolutePaths,
					)
					if (!command) {
						verboseLog("Could not build formatter command")
						return
					}

					verboseLog(`Running formatter: ${command.join(" ")}`)

					// Run the formatter, silently ignoring failures
					yield* fs
						.runCommand(command, {
							cwd: gitRoot,
							captureOutput: true,
						})
						.pipe(
							Effect.catchAll((err) => {
								verboseLog(`Formatter failed (silently ignoring): ${err}`)
								return Effect.void
							}),
						)

					verboseLog(
						`Formatted ${formattableFiles.length} file(s) with ${formatter}`,
					)
				}).pipe(
					// Catch any unexpected errors silently
					Effect.catchAll((err) => {
						verboseLog(`Formatting failed (silently ignoring): ${err}`)
						return Effect.void
					}),
					Effect.catchAllDefect((defect) => {
						verboseLog(`Formatting defect (silently ignoring): ${defect}`)
						return Effect.void
					}),
				),
		}),
	},
) {}
