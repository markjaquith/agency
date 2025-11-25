import { Effect, Either } from "effect"
import type { BaseCommandOptions } from "../utils/command"
import { GitService } from "../services/GitService"
import { ConfigService } from "../services/ConfigService"
import { extractSourceBranch } from "../utils/pr-branch"
import { pr } from "./pr"
import highlight, { done } from "../utils/colors"
import { createLoggers, ensureGitRepo } from "../utils/effect"

interface PushOptions extends BaseCommandOptions {
	baseBranch?: string
	branch?: string
	force?: boolean
}

export const push = (options: PushOptions = {}) =>
	Effect.gen(function* () {
		const { verbose = false } = options
		const { log, verboseLog } = createLoggers(options)

		const git = yield* GitService
		const configService = yield* ConfigService

		const gitRoot = yield* ensureGitRepo()

		// Load config to check PR branch pattern
		const config = yield* configService.loadConfig()

		// Get current branch (this is our source branch we'll return to)
		const sourceBranch = yield* git.getCurrentBranch(gitRoot)

		// Check if we're already on a PR branch
		const isOnPrBranch = extractSourceBranch(sourceBranch, config.prBranch)

		// If we're on a PR branch, throw an error
		if (isOnPrBranch) {
			return yield* Effect.fail(
				new Error(
					`Already on PR branch ${highlight.branch(sourceBranch)}. ` +
						`Run 'agency source' first to switch to the source branch, then run 'agency push'.`,
				),
			)
		}

		verboseLog(`Starting push workflow from ${highlight.branch(sourceBranch)}`)

		// Step 1: Create PR branch (agency pr)
		verboseLog("Step 1: Creating PR branch...")
		// Use pr command
		const prEffectWithOptions = pr({
			baseBranch: options.baseBranch,
			branch: options.branch,
			silent: true, // Suppress pr command output, we'll provide our own
			force: options.force,
			verbose: options.verbose,
		})

		const prResult = yield* Effect.either(prEffectWithOptions)
		if (Either.isLeft(prResult)) {
			const error = prResult.left
			return yield* Effect.fail(
				new Error(
					`Failed to create PR branch: ${error instanceof Error ? error.message : String(error)}`,
				),
			)
		}

		// Get the PR branch name that was created
		const prBranchName = yield* git.getCurrentBranch(gitRoot)
		log(done(`Created PR branch: ${highlight.branch(prBranchName)}`))

		// Step 2: Push to remote (git push)
		verboseLog(`Step 2: Pushing ${highlight.branch(prBranchName)} to remote...`)

		const pushEither = yield* Effect.either(
			pushBranchToRemoteEffect(gitRoot, prBranchName, {
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
			log(done(`Force pushed ${highlight.branch(prBranchName)} to origin`))
		} else {
			log(done(`Pushed ${highlight.branch(prBranchName)} to origin`))
		}

		// Step 3: Switch back to source branch
		// We switch back directly to the source branch we started on,
		// rather than using the source command, to support custom branch names
		verboseLog("Step 3: Switching back to source branch...")

		yield* git.checkoutBranch(gitRoot, sourceBranch)

		log(
			done(`Switched back to source branch: ${highlight.branch(sourceBranch)}`),
		)
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

export const help = `
Usage: agency push [base-branch] [options]

Create a PR branch, push it to remote, and return to the source branch.

This command is a convenience wrapper that runs three operations in sequence:
  1. agency pr [base-branch]  - Create PR branch with managed files reverted
  2. git push -u origin <pr-branch>  - Push PR branch to remote
  3. git checkout <source-branch>  - Switch back to source branch

The command ensures you end up back on your source branch after pushing
the PR branch, making it easy to continue working locally while having
a clean PR branch ready on the remote.

Base Branch Selection:
  Same as 'agency pr' - see 'agency pr --help' for details

Prerequisites:
  - git-filter-repo must be installed: brew install git-filter-repo
  - Remote 'origin' must be configured

Arguments:
  base-branch       Base branch to compare against (e.g., origin/main)
                    If not provided, will use saved config or auto-detect

Options:
  -b, --branch      Custom name for PR branch (defaults to pattern from config)
  -f, --force       Force push to remote if branch has diverged

Examples:
  agency push                          # Create PR, push, return to source
  agency push origin/main              # Explicitly use origin/main as base
  agency push --force                  # Force push if branch has diverged

Notes:
  - Must be run from a source branch (not a PR branch)
  - Creates or recreates the PR branch
  - Pushes with -u flag to set up tracking
  - Automatically returns to source branch after pushing
  - If any step fails, the command stops and reports the error
`
