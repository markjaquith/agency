import { Data, Effect, Either } from "effect"
import { dirname, join, resolve } from "node:path"
import { documentRevision } from "../workbase/document-revision"
import type {
	ClaimRecord,
	PhaseFrontmatter,
	RepositoryReference,
	TaskFrontmatter,
	WorkStatus,
	PullRequestRecord,
} from "../workbase/schemas"
import {
	normalizePullRequestRecord,
	parseOptionalPullRequestRecord,
	recordFromGitHubJson,
	resolveDeliveryCommand,
} from "../workbase/delivery-command"
import { ClaimService } from "./ClaimService"
import { FileSystemService } from "./FileSystemService"
import { PhaseService } from "./PhaseService"
import { TaskService } from "./TaskService"
import { WorkbaseService } from "./WorkbaseService"
import { WorktreeService } from "./WorktreeService"
import {
	RepositoryService,
	type RepositorySetupResult,
} from "./RepositoryService"

class SyncError extends Data.TaggedError("SyncError")<{
	readonly message: string
}> {}

type ExecutionData =
	| PhaseFrontmatter
	| Extract<TaskFrontmatter, { readonly repo: string }>

interface ExecutionRecord {
	readonly key: string
	readonly taskId: string
	readonly phaseId?: string
	readonly path: string
	readonly revision: string
	readonly data: ExecutionData
}

interface RegisteredWorktree {
	readonly path: string
	readonly head: string | null
	readonly branch: string | null
}

interface SyncChange {
	readonly kind:
		| "materialize-workspace"
		| "release-stale-claim"
		| "record-pr"
		| "mark-done"
	readonly target: string
	readonly message: string
	readonly status: "planned" | "applied"
}

interface SyncNotice {
	readonly kind: string
	readonly target: string
	readonly message: string
	readonly action?: string
}

interface CheckoutState {
	readonly repo: string
	readonly kind: "writable" | "reference"
	readonly path: string
	readonly requestedRef: string
	readonly resolvedCommit: string | null
	readonly registered: boolean
	readonly exists: boolean
	readonly head: string | null
	readonly branch: string | null
	readonly dirty: boolean | null
}

interface ExecutionSyncState {
	readonly target: string
	readonly status: WorkStatus
	readonly branch: string
	readonly base: string
	readonly claim: ClaimRecord | null
	readonly checkouts: readonly CheckoutState[]
	readonly pr: Record<string, unknown>
}

interface SyncResult {
	readonly root: string
	readonly mode: "dry-run" | "apply"
	readonly changes: readonly SyncChange[]
	readonly warnings: readonly SyncNotice[]
	readonly unresolved: readonly SyncNotice[]
	readonly executions: readonly ExecutionSyncState[]
	readonly repositories: RepositorySetupResult
}

const parseWorktrees = (output: string): RegisteredWorktree[] => {
	const worktrees: RegisteredWorktree[] = []
	let current: RegisteredWorktree | undefined
	for (const field of output.split("\0")) {
		if (field.startsWith("worktree ")) {
			if (current) worktrees.push(current)
			current = {
				path: field.slice("worktree ".length),
				head: null,
				branch: null,
			}
		} else if (current && field.startsWith("HEAD ")) {
			current = { ...current, head: field.slice("HEAD ".length) }
		} else if (current && field.startsWith("branch ")) {
			current = { ...current, branch: field.slice("branch ".length) }
		}
	}
	if (current) worktrees.push(current)
	return worktrees
}

const parseJson = <T>(value: string, fallback: T): T => {
	try {
		return JSON.parse(value) as T
	} catch {
		return fallback
	}
}

const isExpired = (claim: ClaimRecord | undefined, now: Date) =>
	claim?.state === "active" &&
	claim.expiresAt !== undefined &&
	Date.parse(claim.expiresAt) <= now.getTime()

const isCommitId = (ref: string) => /^[0-9a-f]{40,64}$/i.test(ref)

const originRef = (ref: string) =>
	ref.replace(/^refs\/remotes\/origin\//, "").replace(/^origin\//, "")

export class SyncService extends Effect.Service<SyncService>()("SyncService", {
	sync: () => ({
		reconcile: (
			options: {
				readonly cwd?: string
				readonly apply?: boolean
				readonly now?: Date
			} = {},
		) =>
			Effect.gen(function* () {
				const fs = yield* FileSystemService
				const workbase = yield* WorkbaseService
				const tasks = yield* TaskService
				const phases = yield* PhaseService
				const worktrees = yield* WorktreeService
				const claims = yield* ClaimService
				const repositories = yield* RepositoryService
				const { root, config } = yield* workbase.loadConfig(options.cwd)
				const validation = yield* workbase.validate(root)
				if (!validation.valid) {
					return yield* new SyncError({
						message: validation.issues
							.map((issue) => `${issue.path}: ${issue.message}`)
							.join("\n"),
					})
				}
				const repositorySetup = yield* repositories.setup({
					cwd: root,
					apply: options.apply === true,
				})

				const apply = options.apply === true
				const now = options.now ?? new Date()
				const changes: SyncChange[] = []
				const warnings: SyncNotice[] = []
				const unresolved: SyncNotice[] = []
				for (const issue of repositorySetup.unresolved) {
					unresolved.push({
						kind: `repository-${issue.state}`,
						target: `repository:${issue.alias}`,
						message: issue.message,
						action: issue.action,
					})
				}
				const executions: ExecutionSyncState[] = []
				const runExternal = (
					args: readonly string[],
					commandOptions?: {
						readonly cwd?: string
						readonly env?: Record<string, string>
					},
				) =>
					fs
						.runCommand(args, {
							cwd: commandOptions?.cwd,
							captureOutput: true,
							env: commandOptions?.env,
						})
						.pipe(
							Effect.catchAll((error) =>
								Effect.succeed({
									exitCode: -1,
									stdout: "",
									stderr: error.message,
								}),
							),
						)
				const records: ExecutionRecord[] = []
				for (const task of yield* tasks.list(root)) {
					if ("phases" in task.data) {
						for (const phase of yield* phases.list(task.id, root)) {
							records.push({
								key: `phase:${task.id}/${phase.id}`,
								taskId: task.id,
								phaseId: phase.id,
								path: phase.path,
								revision: documentRevision(phase.content),
								data: phase.data,
							})
						}
					} else {
						records.push({
							key: `task:${task.id}`,
							taskId: task.id,
							path: task.path,
							revision: documentRevision(task.content),
							data: task.data,
						})
					}
				}

				for (const record of records.sort((a, b) =>
					a.key.localeCompare(b.key),
				)) {
					let data = record.data
					let revision = record.revision
					const codePath = join(dirname(record.path), "code")
					const checkoutStates: CheckoutState[] = []
					let materialize = false
					let workspaceConflict = false
					const declared: readonly (
						| { readonly repo: string; readonly branch: string }
						| RepositoryReference
					)[] = [
						{ repo: data.repo, branch: data.branch },
						...(data.repos ?? []),
					]

					for (const checkout of declared) {
						const repositoryPath = join(root, "repos", checkout.repo)
						const checkoutPath = join(codePath, checkout.repo)
						const kind = "branch" in checkout ? "writable" : "reference"
						const requestedRef =
							"branch" in checkout ? checkout.branch : checkout.ref
						if (!(yield* fs.exists(repositoryPath))) {
							unresolved.push({
								kind: "missing-repository",
								target: record.key,
								message: `Repository alias '${checkout.repo}' is missing`,
								action: "Run 'agency repo setup --apply' or relink the alias",
							})
							workspaceConflict = true
							continue
						}
						const listed = yield* fs.runCommand(
							[
								"git",
								"-C",
								repositoryPath,
								"worktree",
								"list",
								"--porcelain",
								"-z",
							],
							{ captureOutput: true },
						)
						if (listed.exitCode !== 0) {
							unresolved.push({
								kind: "worktree-inspection-failed",
								target: record.key,
								message:
									listed.stderr.trim() || `Cannot inspect '${checkout.repo}'`,
							})
							workspaceConflict = true
							continue
						}
						const exists = yield* fs.isDirectory(checkoutPath)
						const registered: RegisteredWorktree[] = []
						for (const item of parseWorktrees(listed.stdout)) {
							registered.push({
								...item,
								path: (yield* fs.exists(item.path))
									? yield* fs.realPath(item.path)
									: resolve(item.path),
							})
						}
						const expectedPath = exists
							? yield* fs.realPath(checkoutPath)
							: (yield* fs.isDirectory(codePath))
								? join(yield* fs.realPath(codePath), checkout.repo)
								: resolve(checkoutPath)
						let atPath = registered.find((item) => item.path === expectedPath)
						const branchRef =
							"branch" in checkout ? `refs/heads/${checkout.branch}` : null
						const branchElsewhere = branchRef
							? registered.find(
									(item) =>
										item.branch === branchRef && item.path !== expectedPath,
								)
							: undefined
						if ("branch" in checkout && !exists && !branchElsewhere) {
							const branch = yield* fs.runCommand(
								[
									"git",
									"-C",
									repositoryPath,
									"rev-parse",
									"--verify",
									`${checkout.branch}^{commit}`,
								],
								{ captureOutput: true },
							)
							if (branch.exitCode !== 0) {
								const base = yield* fs.runCommand(
									[
										"git",
										"-C",
										repositoryPath,
										"rev-parse",
										"--verify",
										`${data.base}^{commit}`,
									],
									{ captureOutput: true },
								)
								if (base.exitCode !== 0) {
									unresolved.push({
										kind: "unresolved-base",
										target: record.key,
										message: `Neither branch '${checkout.branch}' nor base '${data.base}' resolves locally`,
										action: "Fetch or correct the declared branch and base",
									})
									workspaceConflict = true
								}
							}
						}

						if (atPath && !exists) {
							unresolved.push({
								kind: "stale-registration",
								target: record.key,
								message: `Worktree registry points to missing checkout ${checkoutPath}`,
								action:
									"Remove the stale registration after confirming the checkout cannot be restored",
							})
							workspaceConflict = true
						}

						if (branchElsewhere) {
							unresolved.push({
								kind: "branch-conflict",
								target: record.key,
								message: `Branch '${requestedRef}' is checked out at ${branchElsewhere.path}`,
								action: "Remove or relocate the conflicting worktree",
							})
							workspaceConflict = true
						}
						if (exists && !atPath) {
							unresolved.push({
								kind: "unregistered-checkout",
								target: record.key,
								message: `${checkoutPath} exists but is not registered as a worktree`,
								action:
									"Move the unmanaged checkout or repair its registration",
							})
							workspaceConflict = true
						}

						let resolvedCommit: string | null = null
						if ("ref" in checkout) {
							if (!isCommitId(checkout.ref)) {
								const remoteRef = yield* runExternal([
									"git",
									"-C",
									repositoryPath,
									"ls-remote",
									"origin",
									originRef(checkout.ref),
								])
								resolvedCommit =
									remoteRef.stdout.match(/^([0-9a-f]{40,64})\s/m)?.[1] ?? null
								if (!resolvedCommit) {
									warnings.push({
										kind: "reference-remote-unavailable",
										target: record.key,
										message: `Could not inspect remote reference '${checkout.ref}' for '${checkout.repo}'`,
										action:
											"Verify remote access before applying reference changes",
									})
								}
							}
							const resolvedRef = resolvedCommit
								? null
								: yield* fs.runCommand(
										[
											"git",
											"-C",
											repositoryPath,
											"rev-parse",
											"--verify",
											`${checkout.ref}^{commit}`,
										],
										{ captureOutput: true },
									)
							if (resolvedRef?.exitCode === 0) {
								resolvedCommit = resolvedRef.stdout.trim()
							}
							if (!resolvedCommit) {
								unresolved.push({
									kind: "unresolved-reference",
									target: record.key,
									message: `Reference '${checkout.ref}' for '${checkout.repo}' does not resolve locally`,
									action: "Fetch or correct the declared reference",
								})
								workspaceConflict = true
							}
						}

						const dirtyResult =
							exists && atPath
								? yield* fs.runCommand(
										["git", "-C", checkoutPath, "status", "--porcelain"],
										{ captureOutput: true },
									)
								: null
						const dirty = dirtyResult
							? dirtyResult.exitCode === 0
								? dirtyResult.stdout.length > 0
								: null
							: null
						if (dirtyResult && dirtyResult.exitCode !== 0) {
							warnings.push({
								kind: "status-inspection-failed",
								target: record.key,
								message: `Could not inspect dirtiness for ${checkoutPath}: ${dirtyResult.stderr.trim()}`,
								action: "Inspect the checkout manually before changing it",
							})
						}
						if (dirty) {
							warnings.push({
								kind:
									kind === "reference" ? "dirty-reference" : "dirty-writable",
								target: record.key,
								message: `${kind === "reference" ? "Reference" : "Writable"} checkout ${checkoutPath} is dirty`,
								action: "Review and preserve or discard local changes manually",
							})
						}
						if (atPath && branchRef && atPath.branch !== branchRef) {
							unresolved.push({
								kind: "wrong-branch",
								target: record.key,
								message: `${checkoutPath} is not registered to '${requestedRef}'`,
								action: "Repair the writable worktree manually",
							})
							workspaceConflict = true
						}
						if (atPath && "ref" in checkout) {
							if (atPath.branch) {
								unresolved.push({
									kind: "attached-reference",
									target: record.key,
									message: `Reference checkout ${checkoutPath} is attached to ${atPath.branch}`,
								})
								workspaceConflict = true
							} else if (resolvedCommit && atPath.head !== resolvedCommit) {
								unresolved.push({
									kind: "reference-drift",
									target: record.key,
									message: `${checkoutPath} is at ${atPath.head}, expected ${resolvedCommit}`,
									action: dirty
										? "Preserve or discard local changes before recreating the checkout"
										: "Recreate the reference checkout",
								})
								workspaceConflict = true
							}
						}
						if (!exists && !atPath && !branchElsewhere) materialize = true
						checkoutStates.push({
							repo: checkout.repo,
							kind,
							path: checkoutPath,
							requestedRef,
							resolvedCommit,
							registered: Boolean(atPath),
							exists,
							head: atPath?.head ?? null,
							branch: atPath?.branch?.replace(/^refs\/heads\//, "") ?? null,
							dirty,
						})
					}

					if (materialize && !workspaceConflict) {
						if (apply) {
							const workspace = yield* worktrees.materialize(
								record.taskId,
								record.phaseId,
								root,
								{ silent: true },
							)
							for (const checkout of workspace.checkouts) {
								const index = checkoutStates.findIndex(
									(item) => item.repo === checkout.repo,
								)
								if (index >= 0) {
									const previous = checkoutStates[index]!
									checkoutStates[index] = {
										...previous,
										exists: true,
										registered: true,
										resolvedCommit: checkout.resolvedCommit,
										head: checkout.resolvedCommit,
										branch:
											checkout.kind === "writable"
												? checkout.requestedRef
												: null,
										dirty: false,
									}
								}
							}
						}
						changes.push({
							kind: "materialize-workspace",
							target: record.key,
							message: `Materialize missing checkouts under ${codePath}`,
							status: apply ? "applied" : "planned",
						})
					}

					if (
						isExpired(data.claim, now) &&
						(data.status === "working" || data.status === "delegated")
					) {
						const sessionId = data.claim!.sessionId
						if (apply) {
							const expired = yield* claims.expire(
								{
									taskId: record.taskId,
									phaseId: record.phaseId,
									revision,
									now,
								},
								root,
							)
							data = expired.data
							revision = expired.revision
						} else {
							const claim: ClaimRecord = {
								...data.claim!,
								state: "released",
								releasedAt: now.toISOString(),
							}
							data = { ...data, status: "open", claim }
						}
						changes.push({
							kind: "release-stale-claim",
							target: record.key,
							message: `Release expired claim '${sessionId}'`,
							status: apply ? "applied" : "planned",
						})
					} else if (
						data.claim?.state === "active" &&
						data.status !== "working" &&
						data.status !== "delegated"
					) {
						unresolved.push({
							kind: "claim-status-conflict",
							target: record.key,
							message: `Active claim conflicts with '${data.status}' status`,
							action: "Release or finish the claim explicitly",
						})
					}

					if (data.completion) {
						executions.push({
							target: record.key,
							status: data.status,
							branch: data.branch,
							base: data.base,
							claim: data.claim ?? null,
							checkouts: checkoutStates,
							pr: { url: null, state: "none" },
						})
						continue
					}

					const existing = data.pr ? normalizePullRequestRecord(data.pr) : null
					let current: PullRequestRecord | null = existing
					let pr: Record<string, unknown> = existing ?? {
						url: null,
						state: "none",
					}
					let prConflict = false
					const repositoryPath = join(root, "repos", data.repo)
					const remoteName = config.delivery?.remote ?? "origin"
					const remote = yield* runExternal([
						"git",
						"-C",
						repositoryPath,
						"remote",
						"get-url",
						remoteName,
					])
					const remoteRepository = remote.stdout
						.trim()
						.replace(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?[^/]+\//i, "")
						.replace(/^[^:]+:/, "")
						.replace(/\.git\/?$/, "")
						.replace(/\/$/, "")

					if (
						existing &&
						remoteRepository.toLowerCase() !== existing.repository.toLowerCase()
					) {
						prConflict = true
						unresolved.push({
							kind: "pr-repository-conflict",
							target: record.key,
							message: `Recorded PR repository does not match writable repository remote '${remoteName}'`,
							action: "Correct the configured remote or recorded PR",
						})
					}

					if (config.delivery && remote.exitCode !== 0) {
						warnings.push({
							kind: "delivery-remote-unavailable",
							target: record.key,
							message: `Could not inspect delivery remote '${remoteName}': ${remote.stderr.trim()}`,
						})
					} else if (config.delivery) {
						const resolved = resolveDeliveryCommand(config.delivery, "query", {
							repository: remoteRepository,
							branch: data.branch,
							base: data.base,
							draft: existing ? String(existing.draft) : "",
							url: existing?.url ?? "",
							identifier: existing?.identifier ?? "",
						})
						const queried = yield* runExternal(resolved.argv, {
							cwd: repositoryPath,
							env: resolved.environment,
						})
						if (queried.exitCode === 0) {
							const parsed = yield* Effect.try({
								try: () => parseOptionalPullRequestRecord(queried.stdout),
								catch: (cause) =>
									new SyncError({
										message:
											cause instanceof Error ? cause.message : String(cause),
									}),
							}).pipe(Effect.either)
							if (Either.isLeft(parsed)) {
								warnings.push({
									kind: "pr-provider-invalid-output",
									target: record.key,
									message: parsed.left.message,
								})
							} else if (
								parsed.right &&
								(parsed.right.provider !== config.delivery.provider ||
									parsed.right.repository.toLowerCase() !==
										remoteRepository.toLowerCase())
							) {
								if (parsed.right) {
									prConflict = true
									unresolved.push({
										kind: "pr-provider-conflict",
										target: record.key,
										message:
											"Delivery provider returned a record for the wrong provider or repository",
										action: "Correct the delivery provider output",
									})
								}
							} else {
								current = parsed.right
								pr = parsed.right ?? { url: null, state: "none" }
							}
						} else {
							pr = existing
								? { url: existing.url, state: "unavailable" }
								: { url: null, state: "none" }
							warnings.push({
								kind: existing ? "pr-unavailable" : "pr-discovery-unavailable",
								target: record.key,
								message:
									queried.stderr.trim() || "Could not query delivery provider",
							})
						}
					} else if (existing) {
						const viewed = yield* runExternal([
							"gh",
							"pr",
							"view",
							existing.url,
							"--json",
							"number,state,title,isDraft,headRefName,baseRefName,url,mergedAt,mergeCommit,mergeable",
						])
						if (viewed.exitCode === 0) {
							const detail = parseJson<Record<string, unknown>>(
								viewed.stdout,
								{},
							)
							current = recordFromGitHubJson(detail)
							pr = { ...detail, ...current }
							if (
								detail.headRefName !== data.branch ||
								detail.baseRefName !== data.base
							) {
								prConflict = true
								unresolved.push({
									kind: "pr-branch-conflict",
									target: record.key,
									message: `Recorded PR branches do not match '${data.branch}' -> '${data.base}'`,
									action: "Correct the declaration or recorded PR URL",
								})
							}
						} else {
							pr = { url: existing.url, state: "unavailable" }
							warnings.push({
								kind: "pr-unavailable",
								target: record.key,
								message: `Could not inspect ${existing.url}: ${viewed.stderr.trim()}`,
							})
						}
					} else {
						const listed = yield* runExternal(
							[
								"gh",
								"pr",
								"list",
								"--head",
								data.branch,
								"--state",
								"all",
								"--json",
								"number,state,title,isDraft,headRefName,baseRefName,url,mergedAt,mergeCommit,mergeable",
							],
							{ cwd: repositoryPath },
						)
						if (listed.exitCode === 0) {
							const matches = parseJson<Record<string, unknown>[]>(
								listed.stdout,
								[],
							).filter(
								(item) =>
									item.headRefName === data.branch &&
									item.baseRefName === data.base,
							)
							if (matches.length === 1) {
								current = recordFromGitHubJson(matches[0]!)
								pr = { ...matches[0], ...current }
							} else if (matches.length > 1) {
								unresolved.push({
									kind: "multiple-prs",
									target: record.key,
									message: `Multiple pull requests match '${data.branch}' -> '${data.base}'`,
									action: "Record the authoritative PR URL manually",
								})
							}
						} else {
							warnings.push({
								kind: "pr-discovery-unavailable",
								target: record.key,
								message:
									listed.stderr.trim() || "Could not discover pull requests",
							})
						}
					}

					if (current && JSON.stringify(current) !== JSON.stringify(existing)) {
						if (apply) {
							const recorded = yield* claims.reconcile(
								{
									taskId: record.taskId,
									phaseId: record.phaseId,
									revision,
									pr: current,
								},
								root,
							)
							data = recorded.data
							revision = recorded.revision
						}
						changes.push({
							kind: "record-pr",
							target: record.key,
							message: `Record pull request ${current.url}`,
							status: apply ? "applied" : "planned",
						})
					}

					if (
						current?.merged === true &&
						!prConflict &&
						data.status !== "done" &&
						data.status !== "dropped"
					) {
						if (data.claim?.state === "active") {
							unresolved.push({
								kind: "merged-with-active-claim",
								target: record.key,
								message:
									"Pull request is merged while the execution unit remains claimed",
								action: "Finish or release the active claim",
							})
						} else {
							if (apply) {
								const completed = yield* claims.reconcile(
									{
										taskId: record.taskId,
										phaseId: record.phaseId,
										revision,
										status: "done",
									},
									root,
								)
								data = completed.data
								revision = completed.revision
							}
							changes.push({
								kind: "mark-done",
								target: record.key,
								message: "Mark execution unit done from merged pull request",
								status: apply ? "applied" : "planned",
							})
						}
					}

					executions.push({
						target: record.key,
						status: data.status,
						branch: data.branch,
						base: data.base,
						claim: data.claim ?? null,
						checkouts: checkoutStates,
						pr,
					})
				}

				return {
					root,
					mode: apply ? "apply" : "dry-run",
					changes,
					warnings,
					unresolved,
					executions,
					repositories: repositorySetup,
				} satisfies SyncResult
			}),
	}),
}) {}
