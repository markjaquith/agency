import { Data, Effect, Either } from "effect"
import { ContextService } from "./ContextService"
import { FileSystemService } from "./FileSystemService"
import { PhaseService } from "./PhaseService"
import { TaskService } from "./TaskService"
import { WorkbaseService } from "./WorkbaseService"
import { parseGitCommits, type PushCommitMetadata } from "./push-validation"

type PushCategory =
	| "precondition"
	| "commit_validation"
	| "remote_divergence"
	| "hook_rejection"
	| "authentication"
	| "transport"
	| "timeout"
	| "ambiguous_publication"
	| "git"

const categoryMetadata: Record<
	PushCategory,
	{ code: string; retryable: boolean; remediation: string }
> = {
	precondition: {
		code: "PUSH_PRECONDITION",
		retryable: false,
		remediation: "Resolve the local publication precondition and retry.",
	},
	commit_validation: {
		code: "PUSH_COMMIT_VALIDATION",
		retryable: false,
		remediation: "Rewrite the reported outgoing commits and retry.",
	},
	remote_divergence: {
		code: "PUSH_REMOTE_DIVERGENCE",
		retryable: false,
		remediation: "Rebase onto the remote delivery branch before retrying.",
	},
	hook_rejection: {
		code: "PUSH_HOOK_REJECTED",
		retryable: false,
		remediation: "Resolve the hook failure and retry; hooks are not bypassed.",
	},
	authentication: {
		code: "PUSH_AUTHENTICATION",
		retryable: false,
		remediation: "Authenticate Git for the configured remote and retry.",
	},
	transport: {
		code: "PUSH_TRANSPORT",
		retryable: true,
		remediation: "Check remote connectivity and retry.",
	},
	timeout: {
		code: "PUSH_TIMEOUT",
		retryable: true,
		remediation: "Check remote connectivity and retry the bounded operation.",
	},
	ambiguous_publication: {
		code: "PUSH_OUTCOME_UNKNOWN",
		retryable: false,
		remediation:
			"Inspect the exact remote delivery ref before retrying publication.",
	},
	git: {
		code: "PUSH_GIT_ERROR",
		retryable: false,
		remediation: "Resolve the reported Git failure and retry.",
	},
}

class PushError extends Data.TaggedError("PushError")<{
	readonly message: string
	readonly category: PushCategory
	readonly stage: PushStage
	readonly elapsedMs?: number
	readonly protocolCode: string
	readonly retryable: boolean
	readonly remediation: string
}> {}

interface CommandResult {
	readonly exitCode: number
	readonly stdout: string
	readonly stderr: string
}

type CommitMetadata = PushCommitMetadata

interface PushResult {
	readonly vcs: "git"
	readonly taskId: string
	readonly phaseId?: string
	readonly branch: string
	readonly base: string
	readonly remote: string
	readonly tip: string
}

type PushStage =
	| "context"
	| "inspect"
	| "validate"
	| "fetch"
	| "publish"
	| "reconcile"

interface PushOptions {
	readonly onProgress?: (stage: PushStage) => void
	readonly fetchTimeoutMs?: number
	readonly pushTimeoutMs?: number
	readonly retryDelayMs?: number
	readonly forwardOutput?: boolean
}

const validEmail = (email: string) => /^[^@\s]+@[^@\s]+$/.test(email)

const pushError = (
	message: string,
	category: PushCategory,
	stage: PushStage,
	elapsedMs?: number,
) =>
	new PushError({
		message,
		category,
		stage,
		...(elapsedMs === undefined ? {} : { elapsedMs }),
		protocolCode: categoryMetadata[category].code,
		retryable: categoryMetadata[category].retryable,
		remediation: categoryMetadata[category].remediation,
	})

const processTimeout = (error: unknown): { elapsedMs?: number } | null => {
	if (typeof error !== "object" || error === null) return null
	if ("timedOut" in error && error.timedOut === true) {
		return {
			elapsedMs:
				"elapsedMs" in error && typeof error.elapsedMs === "number"
					? error.elapsedMs
					: undefined,
		}
	}
	return "cause" in error ? processTimeout(error.cause) : null
}

const classifyGitFailure = (
	message: string,
	stage: PushStage,
	elapsedMs?: number,
) => {
	const normalized = message.toLowerCase()
	const category: PushCategory =
		/authentication failed|permission denied|could not read username|terminal prompts disabled|credential/.test(
			normalized,
		)
			? "authentication"
			: /pre-push hook|hook declined|remote rejected/.test(normalized)
				? "hook_rejection"
				: /non-fast-forward|fetch first|stale info/.test(normalized)
					? "remote_divergence"
					: /could not resolve|connection|network|remote end hung up|unable to access|repository not found/.test(
								normalized,
						  )
						? "transport"
						: "git"
	return pushError(message, category, stage, elapsedMs)
}

const requireCommand = (
	fs: FileSystemService,
	args: readonly string[],
	cwd: string,
	label: string,
	stage: PushStage,
	options: {
		readonly timeoutMs?: number
		readonly env?: Record<string, string>
		readonly forwardOutput?: boolean
	} = {},
) =>
	Effect.suspend(() => {
		const startedAt = performance.now()
		return fs
			.runCommand(args, {
				cwd,
				captureOutput: true,
				forwardOutput: options.forwardOutput,
				env: options.env,
				timeoutMs: options.timeoutMs,
			})
			.pipe(
				Effect.mapError((error) => {
					const timeout = processTimeout(error)
					const elapsedMs =
						timeout?.elapsedMs ?? Math.round(performance.now() - startedAt)
					return timeout
						? pushError(
								`${label} timed out after ${elapsedMs} ms`,
								"timeout",
								stage,
								elapsedMs,
							)
						: classifyGitFailure(`${label}: ${error.message}`, stage, elapsedMs)
				}),
				Effect.flatMap((result) =>
					result.exitCode === 0
						? Effect.succeed(result)
						: Effect.fail(
								classifyGitFailure(
									`${label}: ${result.stderr.trim() || result.stdout.trim()}`,
									stage,
									Math.round(performance.now() - startedAt),
								),
							),
				),
			)
	})

const git = (
	fs: FileSystemService,
	cwd: string,
	args: readonly string[],
	label: string,
	stage: PushStage,
	options?: Parameters<typeof requireCommand>[5],
) => requireCommand(fs, ["git", ...args], cwd, label, stage, options)

const gitRevision = (
	fs: FileSystemService,
	cwd: string,
	revision: string,
	stage: PushStage = "inspect",
) =>
	fs
		.runCommand(["git", "rev-parse", "--verify", `${revision}^{commit}`], {
			cwd,
			captureOutput: true,
			timeoutMs: 10_000,
		})
		.pipe(
			Effect.mapError((error) => {
				const timeout = processTimeout(error)
				return timeout
					? pushError(
							`Git revision inspection timed out after ${timeout.elapsedMs ?? 10_000} ms`,
							"timeout",
							stage,
							timeout.elapsedMs,
						)
					: classifyGitFailure(
							`Failed to inspect Git revision '${revision}': ${error.message}`,
							stage,
						)
			}),
			Effect.map((result) =>
				result.exitCode === 0 ? result.stdout.trim() || null : null,
			),
		)

const gitAncestor = (
	fs: FileSystemService,
	cwd: string,
	ancestor: string,
	descendant: string,
	stage: PushStage,
) =>
	fs
		.runCommand(["git", "merge-base", "--is-ancestor", ancestor, descendant], {
			cwd,
			captureOutput: true,
			timeoutMs: 10_000,
		})
		.pipe(
			Effect.mapError((error) => {
				const timeout = processTimeout(error)
				return timeout
					? pushError(
							`Git ancestry inspection timed out after ${timeout.elapsedMs ?? 10_000} ms`,
							"timeout",
							stage,
							timeout.elapsedMs,
						)
					: classifyGitFailure(
							`Failed to inspect Git ancestry: ${error.message}`,
							stage,
						)
			}),
			Effect.flatMap((result) => {
				if (result.exitCode === 0) return Effect.succeed(true)
				if (result.exitCode === 1) return Effect.succeed(false)
				return Effect.fail(
					classifyGitFailure(
						`Failed to inspect Git ancestry: ${result.stderr.trim()}`,
						stage,
					),
				)
			}),
		)

const validateGitCommits = (
	commits: readonly CommitMetadata[],
	base: string,
) => {
	if (commits.length === 0) {
		throw pushError(
			`No commits to publish after base '${base}'`,
			"precondition",
			"validate",
		)
	}
	const issues: string[] = []
	for (const commit of commits) {
		if (!commit.description.trim()) {
			issues.push(
				`Commit ${commit.commitId} has an empty message. Run: git rebase -i ${base}`,
			)
		}
		if (!commit.authorName.trim() || !validEmail(commit.authorEmail.trim())) {
			issues.push(
				`Commit ${commit.commitId} has an invalid author. Run: git rebase -i ${base}`,
			)
		}
	}
	if (issues.length > 0)
		throw pushError(issues.join("\n"), "commit_validation", "validate")
}

const positiveInteger = (value: string | undefined, fallback: number) => {
	const parsed = Number.parseInt(value ?? "", 10)
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

const gitEnvironment = (): Record<string, string> => ({
	GIT_TERMINAL_PROMPT: "0",
	GCM_INTERACTIVE: "Never",
	GIT_SSH_COMMAND:
		process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes -o ConnectTimeout=15",
})

const publishGit = (
	fs: FileSystemService,
	checkout: string,
	remote: string,
	branch: string,
	base: string,
	options: PushOptions,
) =>
	Effect.gen(function* () {
		const onProgress = options.onProgress
		const fetchTimeoutMs =
			options.fetchTimeoutMs ??
			positiveInteger(process.env.AGENCY_PUSH_FETCH_TIMEOUT_MS, 30_000)
		const pushTimeoutMs =
			options.pushTimeoutMs ??
			positiveInteger(process.env.AGENCY_PUSH_TIMEOUT_MS, 120_000)
		const retryDelayMs = options.retryDelayMs ?? 250
		const env = gitEnvironment()
		onProgress?.("inspect")
		const currentBranch = yield* git(
			fs,
			checkout,
			["symbolic-ref", "--quiet", "--short", "HEAD"],
			"Git checkout must be attached to the declared branch",
			"inspect",
		)
		if (currentBranch.stdout.trim() !== branch) {
			return yield* pushError(
				`Declared delivery branch '${branch}' does not match checked-out Git branch '${currentBranch.stdout.trim()}'`,
				"precondition",
				"inspect",
			)
		}
		const status = yield* git(
			fs,
			checkout,
			["status", "--porcelain=v1"],
			"Failed to inspect Git status",
			"inspect",
		)
		if (status.stdout.length > 0) {
			return yield* pushError(
				"Cannot publish a dirty Git worktree; commit or discard changes first",
				"precondition",
				"inspect",
			)
		}

		const initialTip = yield* gitRevision(fs, checkout, "HEAD")
		const initialBase = yield* gitRevision(
			fs,
			checkout,
			`refs/remotes/${remote}/${base}`,
		)
		if (initialTip && initialBase) {
			const cachedBaseIsAncestor = yield* gitAncestor(
				fs,
				checkout,
				initialBase,
				initialTip,
				"validate",
			)
			if (cachedBaseIsAncestor) {
				onProgress?.("validate")
				const initialLog = yield* git(
					fs,
					checkout,
					[
						"log",
						"--format=%H%x00%an%x00%ae%x00%B%x00%x1e",
						`${initialBase}..${initialTip}`,
					],
					"Failed to inspect outgoing Git commits",
					"validate",
				)
				yield* Effect.try({
					try: () =>
						validateGitCommits(parseGitCommits(initialLog.stdout), base),
					catch: (cause) => cause as PushError,
				})
			}
		}

		onProgress?.("fetch")
		const fetchRemote = (
			attempt: number,
		): Effect.Effect<CommandResult, PushError> =>
			git(
				fs,
				checkout,
				[
					"fetch",
					"--prune",
					remote,
					`+refs/heads/${base}:refs/remotes/${remote}/${base}`,
					`+refs/heads/${branch}*:refs/remotes/${remote}/${branch}*`,
				],
				`Failed to fetch remote '${remote}'`,
				"fetch",
				{ timeoutMs: fetchTimeoutMs, env },
			).pipe(
				Effect.catchAll((error) =>
					attempt < 2 && ["timeout", "transport"].includes(error.category)
						? Effect.sleep(retryDelayMs + Math.floor(Math.random() * 100)).pipe(
								Effect.flatMap(() => fetchRemote(attempt + 1)),
							)
						: Effect.fail(error),
				),
			)
		yield* fetchRemote(1)
		const [tip, baseRevision] = yield* Effect.all(
			[
				gitRevision(fs, checkout, "HEAD", "validate"),
				gitRevision(fs, checkout, `refs/remotes/${remote}/${base}`, "validate"),
			],
			{ concurrency: "unbounded" },
		)
		if (!tip || !baseRevision) {
			return yield* pushError(
				`Declared base '${base}' was not found on remote '${remote}'`,
				"precondition",
				"validate",
			)
		}
		if (!(yield* gitAncestor(fs, checkout, baseRevision, tip, "validate"))) {
			return yield* pushError(
				`Declared base '${base}' (${baseRevision}) is not an ancestor of Git HEAD (${tip})`,
				"precondition",
				"validate",
			)
		}

		onProgress?.("validate")
		const log = yield* git(
			fs,
			checkout,
			[
				"log",
				"--format=%H%x00%an%x00%ae%x00%B%x00%x1e",
				`${baseRevision}..${tip}`,
			],
			"Failed to inspect outgoing Git commits",
			"validate",
		)
		yield* Effect.try({
			try: () => validateGitCommits(parseGitCommits(log.stdout), base),
			catch: (cause) => cause as PushError,
		})

		const remoteTip = yield* gitRevision(
			fs,
			checkout,
			`refs/remotes/${remote}/${branch}`,
			"validate",
		)
		if (
			remoteTip &&
			!(yield* gitAncestor(fs, checkout, remoteTip, tip, "validate"))
		) {
			return yield* pushError(
				`Remote branch '${branch}' on '${remote}' is not an ancestor of Git HEAD; refusing a non-fast-forward update`,
				"remote_divergence",
				"validate",
			)
		}

		onProgress?.("publish")
		yield* git(
			fs,
			checkout,
			[
				"config",
				`remote.${remote}.fetch`,
				`+refs/heads/*:refs/remotes/${remote}/*`,
			],
			`Failed to configure remote '${remote}' tracking`,
			"publish",
		)
		const pushed = yield* Effect.either(
			git(
				fs,
				checkout,
				[
					"push",
					"-u",
					remote,
					`HEAD:refs/heads/${branch}`,
					`--force-if-includes`,
				],
				`Failed to push declared branch '${branch}'`,
				"publish",
				{
					timeoutMs: pushTimeoutMs,
					env,
					forwardOutput: options.forwardOutput,
				},
			),
		)
		if (Either.isLeft(pushed)) {
			onProgress?.("reconcile")
			const reconciled = yield* Effect.either(
				git(
					fs,
					checkout,
					["ls-remote", "--heads", remote, `refs/heads/${branch}`],
					`Failed to reconcile remote branch '${branch}'`,
					"reconcile",
					{ timeoutMs: fetchTimeoutMs, env },
				),
			)
			if (Either.isLeft(reconciled)) {
				return yield* pushError(
					`Publication outcome is unknown after '${pushed.left.message}' and remote reconciliation also failed: ${reconciled.left.message}`,
					"ambiguous_publication",
					"reconcile",
				)
			}
			const reconciledTip = reconciled.right.stdout.split(/\s+/, 1)[0] || null
			if (reconciledTip === tip) return { tip }
			if (reconciledTip !== remoteTip) {
				return yield* pushError(
					`Publication outcome is unknown: remote branch '${branch}' changed to ${reconciledTip ?? "a missing ref"} while publishing ${tip}`,
					"ambiguous_publication",
					"reconcile",
				)
			}
			return yield* pushed.left
		}
		return { tip }
	})

export class PushService extends Effect.Service<PushService>()("PushService", {
	sync: () => ({
		publish: (startPath: string = process.cwd(), options: PushOptions = {}) =>
			Effect.gen(function* () {
				options.onProgress?.("context")
				const contexts = yield* ContextService
				const fs = yield* FileSystemService
				const tasks = yield* TaskService
				const phases = yield* PhaseService
				const workbase = yield* WorkbaseService
				const context = yield* contexts.get({
					cwd: startPath,
					target: ".",
					compact: true,
				})
				if (!context.validation.valid) {
					return yield* pushError(
						"Cannot publish from an invalid Agency workbase",
						"precondition",
						"context",
					)
				}
				if (context.target.kind !== "task" && context.target.kind !== "phase") {
					return yield* pushError(
						"agency push must run from an execution task or phase",
						"precondition",
						"context",
					)
				}
				if (
					context.authority.mode !== "execution" ||
					!context.authority.writable
				) {
					return yield* pushError(
						"Current Agency target has no writable execution authority",
						"precondition",
						"context",
					)
				}
				if (
					!context.workspace?.writable?.materialized ||
					!context.workspace.writable.registered
				) {
					return yield* pushError(
						"Current Agency writable checkout is not materialized and registered",
						"precondition",
						"context",
					)
				}
				const blockers = context.graph.readiness.blockers.filter(
					(blocker) =>
						blocker.kind === "dependency" || blocker.kind === "validation",
				)
				if (blockers.length > 0) {
					return yield* pushError(
						`Cannot publish blocked Agency work: ${blockers.map((blocker) => blocker.reason).join("; ")}`,
						"precondition",
						"context",
					)
				}

				const taskId = context.target.taskId
				if (!taskId) {
					return yield* pushError(
						"Current Agency execution target has no task ID",
						"precondition",
						"context",
					)
				}
				const phaseId =
					context.target.kind === "phase" ? context.target.phaseId : undefined
				const task = yield* tasks.show(taskId, context.workbase.root)
				const execution =
					"phases" in task.data
						? phaseId
							? (yield* phases.show(taskId, phaseId, context.workbase.root))
									.data
							: null
						: task.data
				if (!execution || "review" in execution) {
					return yield* pushError(
						"Current Agency target is not a delivery execution unit",
						"precondition",
						"context",
					)
				}
				if (execution.status !== "working") {
					return yield* pushError(
						`Cannot publish Agency work with status '${execution.status}'; status must be working`,
						"precondition",
						"context",
					)
				}
				const checkout = context.authority.writable.checkoutPath
				const { config } = yield* workbase.loadConfig(context.workbase.root)
				const remote = config.delivery?.remote ?? "origin"
				const published = yield* publishGit(
					fs,
					checkout,
					remote,
					execution.branch,
					execution.base,
					options,
				)
				return {
					vcs: "git",
					taskId,
					...(phaseId ? { phaseId } : {}),
					branch: execution.branch,
					base: execution.base,
					remote,
					...published,
				} satisfies PushResult
			}),
	}),
}) {}
