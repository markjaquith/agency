import { Context, Deferred, Effect, Layer, Result, Schema } from "effect"
import { FileSystemService } from "./FileSystemService"

const CACHE_TTL_MS = 30_000
const COMMAND_TIMEOUT_MS = 15_000

type PullRequestChecks = "passing" | "failing" | "pending" | "none"
type PullRequestReview =
	| "approved"
	| "changes_requested"
	| "review_required"
	| "none"
type PullRequestMergeMethod = "merge" | "squash" | "rebase"

/** Live review state for one GitHub pull request, read through `gh`. */
export type LivePullRequest =
	| {
			readonly state: "available"
			readonly url: string
			readonly prState: "open" | "closed" | "merged"
			readonly draft: boolean
			readonly review: PullRequestReview
			readonly checks: PullRequestChecks
			readonly mergeable: "mergeable" | "conflicting" | "unknown"
			/** GitHub's mergeStateStatus, such as CLEAN, BLOCKED, or BEHIND. */
			readonly mergeState: string | null
			readonly headSha: string | null
	  }
	| {
			readonly state: "unavailable"
			readonly url: string
			readonly reason: string
	  }

const CheckRun = Schema.Struct({
	__typename: Schema.Literal("CheckRun"),
	status: Schema.optional(Schema.NullOr(Schema.String)),
	conclusion: Schema.optional(Schema.NullOr(Schema.String)),
})
const StatusContext = Schema.Struct({
	__typename: Schema.Literal("StatusContext"),
	state: Schema.optional(Schema.NullOr(Schema.String)),
})
const GitHubPullRequestStatus = Schema.Struct({
	state: Schema.Literals(["OPEN", "CLOSED", "MERGED"]),
	isDraft: Schema.Boolean,
	reviewDecision: Schema.optional(Schema.NullOr(Schema.String)),
	latestReviews: Schema.optional(
		Schema.NullOr(
			Schema.Array(
				Schema.Struct({ state: Schema.optional(Schema.NullOr(Schema.String)) }),
			),
		),
	),
	statusCheckRollup: Schema.optional(
		Schema.NullOr(
			Schema.Array(Schema.Union([CheckRun, StatusContext, Schema.Struct({})])),
		),
	),
	mergeable: Schema.optional(Schema.NullOr(Schema.String)),
	mergeStateStatus: Schema.optional(Schema.NullOr(Schema.String)),
	headRefOid: Schema.optional(Schema.NullOr(Schema.String)),
})
type GitHubPullRequestStatus = Schema.Schema.Type<
	typeof GitHubPullRequestStatus
>

const GitHubRepositoryMergeMethod = Schema.Struct({
	viewerDefaultMergeMethod: Schema.optional(Schema.NullOr(Schema.String)),
})

const PASSING_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"])
const FAILING_CONCLUSIONS = new Set([
	"FAILURE",
	"TIMED_OUT",
	"CANCELLED",
	"ACTION_REQUIRED",
	"STARTUP_FAILURE",
	"STALE",
])

const summarizeChecks = (
	rollup: GitHubPullRequestStatus["statusCheckRollup"],
): PullRequestChecks => {
	if (!rollup?.length) return "none"
	let pending = false
	for (const check of rollup) {
		if ("__typename" in check && check.__typename === "CheckRun") {
			const conclusion = check.conclusion?.toUpperCase() ?? null
			if (conclusion && FAILING_CONCLUSIONS.has(conclusion)) return "failing"
			if (
				check.status?.toUpperCase() !== "COMPLETED" ||
				!conclusion ||
				!PASSING_CONCLUSIONS.has(conclusion)
			)
				pending = true
		} else if ("__typename" in check && check.__typename === "StatusContext") {
			const state = check.state?.toUpperCase() ?? null
			if (state === "FAILURE" || state === "ERROR") return "failing"
			if (state !== "SUCCESS") pending = true
		} else {
			pending = true
		}
	}
	return pending ? "pending" : "passing"
}

const summarizeReview = (
	status: GitHubPullRequestStatus,
): PullRequestReview => {
	switch (status.reviewDecision?.toUpperCase()) {
		case "APPROVED":
			return "approved"
		case "CHANGES_REQUESTED":
			return "changes_requested"
		case "REVIEW_REQUIRED":
			return "review_required"
	}
	// Repositories without required reviews report no decision; fall back to
	// the latest review from each reviewer.
	const states = (status.latestReviews ?? []).map((review) =>
		review.state?.toUpperCase(),
	)
	if (states.includes("CHANGES_REQUESTED")) return "changes_requested"
	if (states.includes("APPROVED")) return "approved"
	return "none"
}

const parseLivePullRequest = (url: string, stdout: string): LivePullRequest => {
	let json: unknown
	try {
		json = JSON.parse(stdout)
	} catch {
		return { state: "unavailable", url, reason: "gh returned invalid JSON" }
	}
	const decoded = Schema.decodeUnknownResult(GitHubPullRequestStatus)(json)
	if (Result.isFailure(decoded)) {
		return {
			state: "unavailable",
			url,
			reason: `gh returned an unexpected response: ${decoded.failure.message}`,
		}
	}
	const status = decoded.success
	const mergeable = status.mergeable?.toUpperCase()
	return {
		state: "available",
		url,
		prState: status.state.toLowerCase() as "open" | "closed" | "merged",
		draft: status.isDraft,
		review: summarizeReview(status),
		checks: summarizeChecks(status.statusCheckRollup),
		mergeable:
			mergeable === "MERGEABLE"
				? "mergeable"
				: mergeable === "CONFLICTING"
					? "conflicting"
					: "unknown",
		mergeState: status.mergeStateStatus?.toUpperCase() || null,
		headSha: status.headRefOid || null,
	}
}

interface CacheEntry<A> {
	readonly expiresAt: number
	readonly value: Deferred.Deferred<A>
}

/** Share one in-flight lookup per key and keep results briefly. */
const cached = <A>(
	cache: Map<string, CacheEntry<A>>,
	key: string,
	lookup: Effect.Effect<A, never, FileSystemService>,
) =>
	Effect.clockWith((clock) =>
		Effect.suspend(() => {
			const now = clock.currentTimeMillisUnsafe()
			const existing = cache.get(key)
			if (existing && existing.expiresAt > now)
				return Deferred.await(existing.value)
			const entry = {
				expiresAt: now + CACHE_TTL_MS,
				value: Deferred.makeUnsafe<A>(),
			}
			cache.set(key, entry)
			return Deferred.into(lookup, entry.value).pipe(
				Effect.onInterrupt(() =>
					Effect.sync(() => {
						if (cache.get(key) === entry) cache.delete(key)
					}),
				),
				Effect.andThen(Deferred.await(entry.value)),
			)
		}),
	)

const runGh = (argv: readonly string[]) =>
	Effect.gen(function* () {
		const fs = yield* FileSystemService
		return yield* fs
			.runCommand(argv, { captureOutput: true, timeoutMs: COMMAND_TIMEOUT_MS })
			.pipe(
				Effect.map((result) =>
					result.exitCode === 0
						? ({ ok: true, stdout: result.stdout } as const)
						: ({
								ok: false,
								reason:
									result.stderr.trim() ||
									result.stdout.trim() ||
									`'${argv.join(" ")}' exited with code ${result.exitCode}`,
							} as const),
				),
				Effect.catch((error) =>
					Effect.succeed({
						ok: false,
						reason: `Could not run 'gh': ${error.message}`,
					} as const),
				),
			)
	})

export class PullRequestStatusService extends Context.Service<PullRequestStatusService>()(
	"PullRequestStatusService",
	{
		make: Effect.sync(() => {
			const statuses = new Map<string, CacheEntry<LivePullRequest>>()
			const mergeMethods = new Map<string, CacheEntry<PullRequestMergeMethod>>()
			return {
				/**
				 * Read live GitHub PR review state; failures become `unavailable`.
				 * `fresh` bypasses the short-lived cache.
				 */
				read: (url: string, options?: { readonly fresh?: boolean }) =>
					Effect.suspend(() => {
						if (options?.fresh) statuses.delete(url)
						return cached(
							statuses,
							url,
							runGh([
								"gh",
								"pr",
								"view",
								url,
								"--json",
								"state,isDraft,reviewDecision,latestReviews,statusCheckRollup,mergeable,mergeStateStatus,headRefOid",
							]).pipe(
								Effect.map(
									(result): LivePullRequest =>
										result.ok
											? parseLivePullRequest(url, result.stdout)
											: { state: "unavailable", url, reason: result.reason },
								),
							),
						)
					}),
				/** The viewer's default merge method for a repository, defaulting to merge. */
				mergeMethod: (repository: string) =>
					cached(
						mergeMethods,
						repository.toLowerCase(),
						runGh([
							"gh",
							"repo",
							"view",
							repository,
							"--json",
							"viewerDefaultMergeMethod",
						]).pipe(
							Effect.map((result): PullRequestMergeMethod => {
								if (!result.ok) return "merge"
								try {
									const decoded = Schema.decodeUnknownOption(
										GitHubRepositoryMergeMethod,
									)(JSON.parse(result.stdout))
									const method =
										decoded._tag === "Some"
											? decoded.value.viewerDefaultMergeMethod?.toLowerCase()
											: undefined
									return method === "squash" || method === "rebase"
										? method
										: "merge"
								} catch {
									return "merge"
								}
							}),
						),
					),
			}
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
