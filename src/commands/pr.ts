import { Effect } from "effect"
import { resolve } from "node:path"
import { ContextService } from "../services/ContextService"
import { FileSystemService } from "../services/FileSystemService"
import { PullRequestService } from "../services/PullRequestService"
import { VersionControlService } from "../services/VersionControlService"
import { WorkbaseService } from "../services/WorkbaseService"
import type { BaseCommandOptions } from "../utils/command"
import { createLoggers } from "../utils/effect"
import { repositoryFromRemote } from "../workbase/delivery-command"

interface PrCreateOptions extends BaseCommandOptions {
	readonly taskId: string
	readonly phaseId?: string
	readonly draft?: boolean
	readonly force?: boolean
	readonly title?: string
	readonly head?: string
	readonly base?: string
	readonly labels?: readonly string[]
}

const branchTargetCommands = new Set([
	"checkout",
	"checks",
	"close",
	"comment",
	"diff",
	"edit",
	"lock",
	"merge",
	"ready",
	"reopen",
	"revert",
	"review",
	"unlock",
	"update-branch",
	"view",
])

const hasOption = (args: readonly string[], short: string, long: string) =>
	args.some(
		(argument) =>
			argument === short ||
			argument.startsWith(`${short}=`) ||
			argument === long ||
			argument.startsWith(`${long}=`),
	)

const withJjContext = (
	args: readonly string[],
	branch: string,
	repository: string,
) => {
	const [command, ...rest] = args
	if (!command) return args

	const branchArgs =
		(command === "create" || command === "new") &&
		!hasOption(rest, "-H", "--head")
			? ["--head", branch]
			: branchTargetCommands.has(command) &&
				  (rest.length === 0 || rest[0]?.startsWith("-"))
				? [branch]
				: []
	const repositoryArgs = hasOption(rest, "-R", "--repo")
		? []
		: ["--repo", repository]

	return [command, ...branchArgs, ...repositoryArgs, ...rest]
}

export const prCreate = (options: PrCreateOptions) =>
	Effect.gen(function* () {
		const pullRequests = yield* PullRequestService
		const { log } = createLoggers(options)
		const url = yield* pullRequests.create(
			options.taskId,
			options.phaseId,
			options.draft,
			options.cwd ?? process.cwd(),
			options,
		)
		log(options.json ? JSON.stringify({ url }, null, 2) : url)
	})

export const pr = (args: readonly string[], cwd: string = process.cwd()) =>
	Effect.gen(function* () {
		const contexts = yield* ContextService
		const fs = yield* FileSystemService
		const workbase = yield* WorkbaseService
		const versionControl = yield* VersionControlService
		const invocationCwd = resolve(cwd)
		const context = yield* contexts
			.get({ cwd: invocationCwd, target: ".", compact: true })
			.pipe(Effect.catchAll(() => Effect.succeed(null)))
		const writableCheckout =
			context?.validation.valid && context.workspace?.writable?.materialized
				? context.authority.writable?.checkoutPath
				: null
		const reviewCheckout =
			context?.validation.valid && context.review?.checkout?.materialized
				? context.review.checkout.checkoutPath
				: null
		const focusedCheckout = writableCheckout ?? reviewCheckout
		const focusedCwd = focusedCheckout ?? invocationCwd
		let forwardedArgs = args
		let environment: Record<string, string> = {}
		if (focusedCheckout && context?.workbase.vcs === "jj") {
			if (writableCheckout && context.authority.writable) {
				const execution =
					context.documents?.phase?.data ?? context.documents?.task?.data
				const { config } = yield* workbase.loadConfig(context.workbase.root)
				const remote =
					config.repositories?.[context.authority.writable.repo]?.remote
				if (execution && "branch" in execution && remote) {
					forwardedArgs = withJjContext(
						args,
						execution.branch,
						repositoryFromRemote(remote),
					)
				}
			}
			const backend = yield* versionControl.forWorkbase(context.workbase.root)
			environment = yield* backend.gitEnvironment(focusedCheckout)
		}
		const result = yield* fs.runCommand(["gh", "pr", ...forwardedArgs], {
			cwd: focusedCwd,
			passthrough: true,
			env: environment,
		})
		return result.exitCode
	})

export const help = `
Usage: agency pr create <task-id> [phase-id] [options]
       agency pr [args...]

Create records a pull request for an Agency execution unit and accepts the
options listed below. Invocations without an Agency task target run gh pr
unchanged, focusing the writable repository checkout when invoked from
an Agency execution task or phase. In jj workbases, Agency supplies the declared
branch and repository to gh subcommands that would otherwise infer Git context.

Options:
  --draft                   Create the pull request as a draft
  --title <title>           Override the generated pull request title
  --head <branch>           Confirm the declared head branch
  --base <branch>           Confirm the declared base branch
  --label <label>           Add a label (repeatable)
  --force                   Override readiness checks
  --json                    Output one versioned machine result
`
