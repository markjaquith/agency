import { Effect, Either } from "effect"
import type { BaseCommandOptions } from "../utils/command"
import { GitService } from "../services/GitService"
import { ConfigService } from "../services/ConfigService"
import {
	extractSourceBranch,
	makePrBranchName,
	resolveBranchPairWithAgencyJson,
} from "../utils/pr-branch"
import { FileSystemService } from "../services/FileSystemService"
import { emit } from "./emit"
import highlight, { done } from "../utils/colors"
import {
	createLoggers,
	ensureGitRepo,
	getRemoteName,
	withBranchProtection,
} from "../utils/effect"
import { withSpinner } from "../utils/spinner"
import { spawnProcess } from "../utils/process"

interface PushOptions extends BaseCommandOptions {
	baseBranch?: string
	emit?: string
	branch?: string // Deprecated: use emit instead
	force?: boolean
	pr?: boolean
	skipFilter?: boolean
}

export const push = (options: PushOptions = {}) =>
	Effect.gen(function* () {
		const gitRoot = yield* ensureGitRepo()

		// Wrap the entire push operation with branch protection
		// This ensures we return to the original branch on Ctrl-C interrupt
		yield* withBranchProtection(gitRoot, pushCore(gitRoot, options))
	})

const pushCore = (gitRoot: string, options: PushOptions) =>
	Effect.gen(function* () {
		const { verbose = false } = options
		const { log, verboseLog } = createLoggers(options)

		const git = yield* GitService
		const configService = yield* ConfigService

		// Load config to check emit branch pattern
		const config = yield* configService.loadConfig()

		// Get current branch
		let sourceBranch = yield* git.getCurrentBranch(gitRoot)

		// Check if we're already on an emit branch using proper branch resolution
		const fs = yield* FileSystemService
		const branchInfo = yield* resolveBranchPairWithAgencyJson(
			gitRoot,
			sourceBranch,
			config.sourceBranchPattern,
			config.emitBranch,
		)

		// If we're on an emit branch, switch to the source branch first
		if (branchInfo.isOnEmitBranch) {
			const actualSourceBranch = branchInfo.sourceBranch
			// Check if the source branch exists
			const sourceExists = yield* git.branchExists(gitRoot, actualSourceBranch)
			if (sourceExists) {
				verboseLog(
					`Currently on emit branch ${highlight.branch(sourceBranch)}, switching to source branch ${highlight.branch(actualSourceBranch)}`,
				)
				yield* git.checkoutBranch(gitRoot, actualSourceBranch)
				sourceBranch = actualSourceBranch
			}
		}

		verboseLog(`Starting push workflow from ${highlight.branch(sourceBranch)}`)

		// Step 1: Create emit branch (agency emit)
		let emitHadIgnorableFailure = false

		if (!options.skipFilter) {
			verboseLog("Step 1: Emitting...")
			// Use emit command - prefer emit option, fallback to branch for backward compatibility
			const prEffectWithOptions = emit({
				baseBranch: options.baseBranch,
				emit: options.emit || options.branch,
				silent: true, // Suppress emit command output, we'll provide our own
				force: options.force,
				verbose: options.verbose,
				skipFilter: options.skipFilter,
			})

			const prResult = yield* Effect.either(prEffectWithOptions)
			if (Either.isLeft(prResult)) {
				const error =
					prResult.left instanceof Error
						? prResult.left
						: new Error(String(prResult.left))
				const message = error.message || ""
				const ignorable =
					message === "" ||
					message.includes("already exists") ||
					message.includes("check if branch exists")

				if (!ignorable) {
					return yield* Effect.fail(
						new Error(`Failed to create emit branch: ${message}`),
					)
				}

				emitHadIgnorableFailure = true
				verboseLog("Emit reported existing branch; continuing")
			}
		}

		// Compute the emit branch name (emit() command now stays on source branch)
		// Use the branchInfo we already computed earlier
		const emitBranchName =
			options.emit || options.branch || branchInfo.emitBranch

		// If skipFilter, we skipped emit() so we must create the emit branch manually
		if (options.skipFilter) {
			yield* git.createOrResetBranch(gitRoot, emitBranchName, sourceBranch)
			// Switch back to source branch for consistency
			yield* git.checkoutBranch(gitRoot, sourceBranch)
		}

		log(done(`Emitted ${highlight.branch(emitBranchName)}`))

		// Step 2: Push to remote (git push)
		const remote = yield* getRemoteName(gitRoot)
		verboseLog(
			`Step 2: Pushing ${highlight.branch(emitBranchName)} to ${highlight.remote(remote)}...`,
		)

		// Switch to emit branch before pushing so that pre-push hooks run
		// in the context of the emit branch (without backpack files)
		yield* git.checkoutBranch(gitRoot, emitBranchName)

		const pushEither = yield* Effect.either(
			withSpinner(
				pushBranchToRemoteEffect(gitRoot, emitBranchName, remote, {
					force: options.force,
					verbose: options.verbose,
				}),
				{
					text: options.force
						? `Pushing to ${highlight.remote(remote)} (forced)`
						: `Pushing to ${highlight.remote(remote)}`,
					enabled: !options.silent && !options.verbose,
				},
			),
		)
		if (Either.isLeft(pushEither)) {
			const error = pushEither.left
			// If push failed, switch back to source branch
			yield* git.checkoutBranch(gitRoot, sourceBranch)
			return yield* Effect.fail(error)
		}

		const usedForce = pushEither.right

		if (usedForce) {
			log(done(`Pushed to ${highlight.remote(remote)} (forced)`))
		} else {
			log(done(`Pushed to ${highlight.remote(remote)}`))
		}

		// Step 3 (optional): Open GitHub PR if --pr flag is set
		if (options.pr) {
			verboseLog("Step 3: Opening GitHub PR...")

			const ghEither = yield* Effect.either(
				openGitHubPR(gitRoot, emitBranchName, {
					verbose: options.verbose,
				}),
			)

			if (Either.isLeft(ghEither)) {
				const error = ghEither.left
				// Don't fail the entire command if gh fails, just warn
				console.error(
					`⚠ Failed to open GitHub PR: ${error instanceof Error ? error.message : String(error)}`,
				)
			} else {
				log(done("Opened GitHub PR in browser"))
			}
		}

		// Switch back to source branch
		yield* git.checkoutBranch(gitRoot, sourceBranch)
	})

// Helper: Push branch to remote with optional force and retry logic
const pushBranchToRemoteEffect = (
	gitRoot: string,
	branchName: string,
	remote: string,
	options: {
		readonly force?: boolean
		readonly verbose?: boolean
	},
) =>
	Effect.gen(function* () {
		const git = yield* GitService
		const { force = false } = options

		// Try pushing without force first
		const pushResult = yield* git
			.push(gitRoot, remote, branchName, { setUpstream: true })
			.pipe(
				Effect.catchAll((error: any) =>
					Effect.succeed({
						exitCode: error.exitCode ?? -1,
						stdout: "",
						stderr: error.stderr ?? String(error),
					}),
				),
			)

		let usedForce = false

		// If push failed, check if we should retry with --force
		if (pushResult.exitCode !== 0) {
			const stderr = pushResult.stderr

			// Check if this is a force-push-needed error
			const needsForce =
				stderr.includes("rejected") ||
				stderr.includes("non-fast-forward") ||
				stderr.includes("fetch first") ||
				stderr.includes("Updates were rejected")

			if (needsForce && force) {
				// User provided --force flag, retry with force
				const forceResult = yield* git
					.push(gitRoot, remote, branchName, { setUpstream: true, force: true })
					.pipe(
						Effect.catchAll((error: any) =>
							Effect.succeed({
								exitCode: error.exitCode ?? -1,
								stdout: "",
								stderr: error.stderr ?? String(error),
							}),
						),
					)

				if (forceResult.exitCode !== 0) {
					return yield* Effect.fail(
						new Error(
							`Failed to force push branch to remote: ${forceResult.stderr}`,
						),
					)
				}

				usedForce = true
			} else if (needsForce && !force) {
				// User didn't provide --force but it's needed
				return yield* Effect.fail(
					new Error(
						`Failed to push branch to remote. The branch has diverged from the remote.\n` +
							`Run 'agency push --force' to force push the branch.`,
					),
				)
			} else {
				// Some other error
				return yield* Effect.fail(
					new Error(`Failed to push branch to remote: ${stderr}`),
				)
			}
		}

		return usedForce
	})

// Helper: Open GitHub PR using gh CLI
const openGitHubPR = (
	gitRoot: string,
	branchName: string,
	options: {
		readonly verbose?: boolean
	},
) =>
	Effect.gen(function* () {
		const { verbose = false } = options

		// Run gh pr create --web with --head to specify the emit branch
		// Set environment variables to ensure non-interactive mode in CI
		// Add a 3 second timeout to prevent hanging in CI environments
		const ghEffect = spawnProcess(
			["gh", "pr", "create", "--web", "--head", branchName],
			{
				cwd: gitRoot,
				stdout: verbose ? "inherit" : "pipe",
				stderr: "pipe",
				env: {
					GH_PROMPT_DISABLED: "1",
					NO_COLOR: "1",
				},
			},
		).pipe(
			Effect.timeout("3 seconds"),
			Effect.catchAll((error) => {
				// Handle timeout or process errors
				if (error._tag === "TimeoutException") {
					return Effect.succeed({
						exitCode: -1,
						stdout: "",
						stderr: "gh command timed out after 3 seconds",
					})
				}
				// Handle ProcessError
				return Effect.succeed({
					exitCode: (error as any).exitCode ?? -1,
					stdout: "",
					stderr: (error as any).stderr ?? String(error),
				})
			}),
		)

		const ghResult = yield* ghEffect

		if (ghResult.exitCode !== 0) {
			return yield* Effect.fail(
				new Error(`gh CLI command failed: ${ghResult.stderr.trim()}`),
			)
		}
	})

export const help = `
Usage: agency push [base-branch] [options]

Create a emit branch, push it to remote, and return to the source branch.

This command is a convenience wrapper that runs operations in sequence:
  1. agency emit [base-branch]  - Create emit branch with backpack files reverted
  2. git push -u origin <pr-branch>  - Push emit branch to remote
  3. gh pr create --web (optional with --pr)  - Open GitHub PR in browser
  4. git checkout <source-branch>  - Switch back to source branch

The command ensures you end up back on your source branch after pushing
the emit branch, making it easy to continue working locally while having
a clean emit branch ready on the remote.

Base Branch Selection:
  Same as 'agency emit' - see 'agency emit --help' for details

Prerequisites:
  - git-filter-repo must be installed: brew install git-filter-repo
  - Remote 'origin' must be configured

Arguments:
  base-branch       Base branch to compare against (e.g., origin/main)
                    If not provided, will use saved config or auto-detect

Options:
  --emit            Custom name for emit branch (defaults to pattern from config)
  --branch          (Deprecated: use --emit) Custom name for emit branch
  -f, --force       Force push to remote if branch has diverged
  --pr              Open GitHub PR in browser after pushing (requires gh CLI)

Examples:
  agency push                          # Create PR, push, return to source
  agency push origin/main              # Explicitly use origin/main as base
  agency push --force                  # Force push if branch has diverged
  agency push --pr                     # Push and open GitHub PR in browser

Notes:
  - Must be run from a source branch (not a emit branch)
  - Creates or recreates the emit branch
  - Pushes with -u flag to set up tracking
  - Automatically returns to source branch after pushing
  - If any step fails, the command stops and reports the error
`
