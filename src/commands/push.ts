import { Effect, Either } from "effect"
import type { BaseCommandOptions } from "../utils/command"
import { GitService } from "../services/GitService"
import { ConfigService } from "../services/ConfigService"
import { extractSourceBranch, makePrBranchName } from "../utils/pr-branch"
import { emit } from "./emit"
import highlight, { done } from "../utils/colors"
import { createLoggers, ensureGitRepo } from "../utils/effect"

interface PushOptions extends BaseCommandOptions {
	baseBranch?: string
	branch?: string
	force?: boolean
	gh?: boolean
}

export const push = (options: PushOptions = {}) =>
	Effect.gen(function* () {
		const { verbose = false } = options
		const { log, verboseLog } = createLoggers(options)

		const git = yield* GitService
		const configService = yield* ConfigService

		const gitRoot = yield* ensureGitRepo()

		// Load config to check emit branch pattern
		const config = yield* configService.loadConfig()

		// Get current branch (this is our source branch we'll return to)
		let sourceBranch = yield* git.getCurrentBranch(gitRoot)

		// Check if we're already on a emit branch
		const possibleSourceBranch = extractSourceBranch(
			sourceBranch,
			config.emitBranch,
		)

		// If we're on a emit branch, switch to the source branch first
		if (possibleSourceBranch) {
			// Check if the possible source branch exists
			const sourceExists = yield* git.branchExists(
				gitRoot,
				possibleSourceBranch,
			)
			if (sourceExists) {
				verboseLog(
					`Currently on emit branch ${highlight.branch(sourceBranch)}, switching to source branch ${highlight.branch(possibleSourceBranch)}`,
				)
				yield* git.checkoutBranch(gitRoot, possibleSourceBranch)
				sourceBranch = possibleSourceBranch
			}
		}

		verboseLog(`Starting push workflow from ${highlight.branch(sourceBranch)}`)

		// Step 1: Create emit branch (agency emit)
		verboseLog("Step 1: Emitting...")
		// Use emit command
		const prEffectWithOptions = emit({
			baseBranch: options.baseBranch,
			branch: options.branch,
			silent: true, // Suppress emit command output, we'll provide our own
			force: options.force,
			verbose: options.verbose,
		})

		const prResult = yield* Effect.either(prEffectWithOptions)
		if (Either.isLeft(prResult)) {
			const error = prResult.left
			return yield* Effect.fail(
				new Error(
					`Failed to create emit branch: ${error instanceof Error ? error.message : String(error)}`,
				),
			)
		}

		// Compute the emit branch name (emit() command now stays on source branch)
		const emitBranchName =
			options.branch || makePrBranchName(sourceBranch, config.emitBranch)
		log(done(`Emitted ${highlight.branch(emitBranchName)}`))

		// Step 2: Push to remote (git push)
		verboseLog(
			`Step 2: Pushing ${highlight.branch(emitBranchName)} to remote...`,
		)

		const pushEither = yield* Effect.either(
			pushBranchToRemoteEffect(gitRoot, emitBranchName, {
				force: options.force,
				verbose: options.verbose,
			}),
		)
		if (Either.isLeft(pushEither)) {
			const error = pushEither.left
			// If push failed, switch back to source branch before rethrowing
			verboseLog(
				"Push failed, switching back to source branch before reporting error...",
			)
			yield* git.checkoutBranch(gitRoot, sourceBranch)
			return yield* Effect.fail(error)
		}

		const usedForce = pushEither.right

		if (usedForce) {
			log(done(`Force pushed ${highlight.branch(emitBranchName)} to origin`))
		} else {
			log(done(`Pushed ${highlight.branch(emitBranchName)} to origin`))
		}

		// Step 3 (optional): Open GitHub PR if --gh flag is set
		if (options.gh) {
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

		// Verify we're still on the source branch (emit() now stays on source branch)
		const currentBranch = yield* git.getCurrentBranch(gitRoot)
		if (currentBranch !== sourceBranch) {
			// This shouldn't happen with the new emit() behavior, but check anyway
			verboseLog(
				`Switching back to source branch ${highlight.branch(sourceBranch)}...`,
			)
			yield* git.checkoutBranch(gitRoot, sourceBranch)
		}

		log(done(`Ready to continue work on ${highlight.branch(sourceBranch)}`))
	})

// Helper: Push branch to remote with optional force and retry logic
const pushBranchToRemoteEffect = (
	gitRoot: string,
	branchName: string,
	options: {
		readonly force?: boolean
		readonly verbose?: boolean
	},
) =>
	Effect.gen(function* () {
		const { force = false, verbose = false } = options

		// Try pushing without force first
		let pushProc = Bun.spawn(["git", "push", "-u", "origin", branchName], {
			cwd: gitRoot,
			stdout: verbose ? "inherit" : "pipe",
			stderr: "pipe",
		})

		yield* Effect.promise(() => pushProc.exited)

		let usedForce = false

		// If push failed, check if we should retry with --force
		if (pushProc.exitCode !== 0) {
			const stderr = yield* Effect.promise(() =>
				new Response(pushProc.stderr).text(),
			)

			// Check if this is a force-push-needed error
			const needsForce =
				stderr.includes("rejected") ||
				stderr.includes("non-fast-forward") ||
				stderr.includes("fetch first") ||
				stderr.includes("Updates were rejected")

			if (needsForce && force) {
				// User provided --force flag, retry with force
				pushProc = Bun.spawn(
					["git", "push", "-u", "--force", "origin", branchName],
					{
						cwd: gitRoot,
						stdout: verbose ? "inherit" : "pipe",
						stderr: "pipe",
					},
				)

				yield* Effect.promise(() => pushProc.exited)

				if (pushProc.exitCode !== 0) {
					const forcedStderr = yield* Effect.promise(() =>
						new Response(pushProc.stderr).text(),
					)
					return yield* Effect.fail(
						new Error(`Failed to force push branch to remote: ${forcedStderr}`),
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

		// Run gh pr create --web to open PR in browser
		const ghProc = Bun.spawn(["gh", "pr", "create", "--web"], {
			cwd: gitRoot,
			stdout: verbose ? "inherit" : "pipe",
			stderr: "pipe",
		})

		yield* Effect.promise(() => ghProc.exited)

		if (ghProc.exitCode !== 0) {
			const stderr = yield* Effect.promise(() =>
				new Response(ghProc.stderr).text(),
			)
			return yield* Effect.fail(
				new Error(`gh CLI command failed: ${stderr.trim()}`),
			)
		}
	})

export const help = `
Usage: agency push [base-branch] [options]

Create a emit branch, push it to remote, and return to the source branch.

This command is a convenience wrapper that runs operations in sequence:
  1. agency emit [base-branch]  - Create emit branch with backpack files reverted
  2. git push -u origin <pr-branch>  - Push emit branch to remote
  3. gh pr create --web (optional with --gh)  - Open GitHub PR in browser
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
  -b, --branch      Custom name for emit branch (defaults to pattern from config)
  -f, --force       Force push to remote if branch has diverged
  --gh              Open GitHub PR in browser after pushing (requires gh CLI)

Examples:
  agency push                          # Create PR, push, return to source
  agency push origin/main              # Explicitly use origin/main as base
  agency push --force                  # Force push if branch has diverged
  agency push --gh                     # Push and open GitHub PR in browser

Notes:
  - Must be run from a source branch (not a emit branch)
  - Creates or recreates the emit branch
  - Pushes with -u flag to set up tracking
  - Automatically returns to source branch after pushing
  - If any step fails, the command stops and reports the error
`
