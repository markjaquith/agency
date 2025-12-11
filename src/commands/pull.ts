import { Effect } from "effect"
import type { BaseCommandOptions } from "../utils/command"
import { IsomorphicGitService as GitService } from "../services/IsomorphicGitService"
import { ConfigService } from "../services/ConfigService"
import { resolveBranchPairWithAgencyJson } from "../utils/pr-branch"
import highlight, { done } from "../utils/colors"
import {
	createLoggers,
	ensureGitRepo,
	withBranchProtection,
} from "../utils/effect"
import { withSpinner } from "../utils/spinner"

interface PullOptions extends BaseCommandOptions {
	remote?: string
}

export const pull = (options: PullOptions = {}) =>
	Effect.gen(function* () {
		const gitRoot = yield* ensureGitRepo()

		// Wrap the entire pull operation with branch protection
		// This ensures we return to the original branch on Ctrl-C interrupt
		yield* withBranchProtection(gitRoot, pullCore(gitRoot, options))
	})

const pullCore = (gitRoot: string, options: PullOptions) =>
	Effect.gen(function* () {
		const { verbose = false } = options
		const { log, verboseLog } = createLoggers(options)

		const git = yield* GitService
		const configService = yield* ConfigService

		// Resolve remote name (use provided option, config, or auto-detect)
		const remote = options.remote
			? yield* git.resolveRemote(gitRoot, options.remote)
			: yield* git.resolveRemote(gitRoot)

		// Load config
		const config = yield* configService.loadConfig()

		// Get current branch
		let currentBranch = yield* git.getCurrentBranch(gitRoot)

		// Resolve branch pair to find source and emit branches
		const branches = yield* resolveBranchPairWithAgencyJson(
			gitRoot,
			currentBranch,
			config.sourceBranchPattern,
			config.emitBranch,
		)
		const { sourceBranch, emitBranch, isOnEmitBranch } = branches

		// If we're on emit branch, switch to source branch
		if (isOnEmitBranch) {
			verboseLog(
				`Currently on emit branch ${highlight.branch(currentBranch)}, switching to source branch ${highlight.branch(sourceBranch)}`,
			)
			const sourceExists = yield* git.branchExists(gitRoot, sourceBranch)
			if (!sourceExists) {
				return yield* Effect.fail(
					new Error(
						`Source branch ${highlight.branch(sourceBranch)} does not exist`,
					),
				)
			}
			yield* git.checkoutBranch(gitRoot, sourceBranch)
			currentBranch = sourceBranch
		}

		verboseLog(`Source branch: ${highlight.branch(sourceBranch)}`)
		verboseLog(`Emit branch: ${highlight.branch(emitBranch)}`)

		// Fetch the remote emit branch
		const remoteEmitBranch = `${remote}/${emitBranch}`
		const fetchOperation = Effect.gen(function* () {
			const result = yield* git.fetch(gitRoot, remote, emitBranch).pipe(
				Effect.map(() => true),
				Effect.catchAll(() => Effect.succeed(false)),
			)

			if (!result) {
				return yield* Effect.fail(
					new Error(
						`Failed to fetch ${highlight.branch(remoteEmitBranch)}. Does the remote branch exist?`,
					),
				)
			}

			verboseLog(`Fetched ${highlight.branch(remoteEmitBranch)}`)

			// Check if remote emit branch exists after fetch
			const remoteExists = yield* git.branchExists(gitRoot, remoteEmitBranch)
			if (!remoteExists) {
				return yield* Effect.fail(
					new Error(
						`Remote emit branch ${highlight.branch(remoteEmitBranch)} does not exist`,
					),
				)
			}
		})

		yield* withSpinner(fetchOperation, {
			text: `Fetching ${highlight.branch(remoteEmitBranch)}`,
			successText: `Fetched ${highlight.branch(remoteEmitBranch)}`,
			enabled: !options.silent && !verbose,
		})

		// Check if local emit branch exists
		const localEmitExists = yield* git.branchExists(gitRoot, emitBranch)
		if (!localEmitExists) {
			verboseLog(
				`Local emit branch ${highlight.branch(emitBranch)} does not exist, comparing against source branch`,
			)
		}

		// Get the list of commits on remote emit branch that aren't on local emit branch
		// If local emit branch doesn't exist, compare against source branch
		const compareBase = localEmitExists ? emitBranch : sourceBranch
		verboseLog(
			`Comparing ${highlight.branch(remoteEmitBranch)} against ${highlight.branch(compareBase)}`,
		)

		const commitsResult = yield* git
			.getCommitsBetween(gitRoot, compareBase, remoteEmitBranch)
			.pipe(Effect.catchAll(() => Effect.succeed("")))

		if (!commitsResult || commitsResult.trim() === "") {
			log(done("No new commits to pull"))
			return
		}

		const commits = commitsResult.split("\n").filter((c) => c.trim().length > 0)
		verboseLog(`Found ${commits.length} commits to cherry-pick`)

		// Cherry-pick each commit
		let successCount = 0
		let failedCommit: string | null = null

		for (const commit of commits) {
			verboseLog(`Cherry-picking ${highlight.commit(commit.substring(0, 8))}`)

			const result = yield* git.cherryPick(gitRoot, commit).pipe(
				Effect.map(() => true),
				Effect.catchAll(() => {
					failedCommit = commit
					return Effect.succeed(false)
				}),
			)

			if (!result) {
				break
			}

			successCount++
		}

		if (failedCommit) {
			log(
				`Cherry-picked ${successCount} of ${commits.length} commits before conflict`,
			)
			return yield* Effect.fail(
				new Error(
					`Cherry-pick conflict at commit ${highlight.commit(failedCommit.substring(0, 8))}. Resolve conflicts and continue with: git cherry-pick --continue`,
				),
			)
		}

		log(
			done(
				`Pulled ${commits.length} commit${commits.length === 1 ? "" : "s"} from ${highlight.branch(remoteEmitBranch)}`,
			),
		)
	})

export const help = `
Usage: agency pull [options]

Pull commits from the remote emit branch and cherry-pick them onto the source branch.

This command is useful when someone else has pushed commits to the emit branch
(e.g., after a PR review) and you want to bring those changes back into your
source branch.

Workflow:
  1. Determines the source and emit branch names
  2. If on emit branch, switches to source branch
  3. Fetches the remote emit branch
  4. Finds commits on remote emit branch that aren't on source branch
  5. Cherry-picks each commit onto the source branch

Options:
  -r, --remote      Remote name to fetch from (defaults to 'origin')

Examples:
  agency pull                       # Pull from origin/<emit-branch>
  agency pull --remote upstream     # Pull from upstream/<emit-branch>

Notes:
  - If a cherry-pick conflict occurs, you'll need to resolve it manually
  - Use 'git cherry-pick --continue' after resolving conflicts
  - The command will stop at the first conflict
  - Only commits that don't exist on the source branch are cherry-picked
`
