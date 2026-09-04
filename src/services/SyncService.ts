import { Data, Effect, Either } from "effect"
import { dirname, join, resolve } from "node:path"
import type {
	PhaseFrontmatter,
	RepositoryReference,
	TaskFrontmatter,
	WorkStatus,
	PullRequestRecord,
} from "../workbase/schemas"
import { documentRevision } from "../workbase/document-revision"
import {
	formatMarkdownDocument,
	parseFrontmatterSync,
} from "../workbase/frontmatter"
import {
	normalizePullRequestRecord,
	parseOptionalPullRequestRecord,
	recordFromGitHubJson,
	resolveDeliveryCommand,
} from "../workbase/delivery-command"
import { FileSystemService } from "./FileSystemService"
import {
	documentWriteStep,
	runLifecycleTransaction,
} from "./LifecycleTransaction"
import { WorkbaseService } from "./WorkbaseService"
import { WorktreeService } from "./WorktreeService"
import {
	RepositoryService,
	type RepositorySetupResult,
} from "./RepositoryService"
import { VersionControlService } from "./VersionControlService"

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
	readonly content: string
	readonly revision: string
	readonly data: ExecutionData
}

interface RegisteredWorktree {
	readonly path: string
	readonly head: string | null
	readonly branch: string | null
	readonly dirty?: boolean
}

interface SyncChange {
	readonly kind: "materialize-workspace" | "record-pr" | "mark-done"
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
	readonly branch: string | null
	readonly base: string | null
	readonly checkouts: readonly CheckoutState[]
	readonly pr: Record<string, unknown>
	readonly review?: {
		readonly pinnedCommit: string
		readonly sourceCommit: string | null
		readonly sourceAvailable: boolean
	}
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

export interface SyncProgress {
	readonly stage: "repositories" | "pull-requests" | "executions"
	readonly current: number
	readonly total: number
	readonly target?: string
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

const isCommitId = (ref: string) => /^[0-9a-f]{40,64}$/i.test(ref)

const originRef = (ref: string) =>
	ref.replace(/^refs\/remotes\/origin\//, "").replace(/^origin\//, "")

const GITHUB_PR_FIELDS =
	"number,state,title,isDraft,headRefName,baseRefName,headRepository,url,mergedAt,mergeCommit,mergeable"

const commandErrorSummary = (stderr: string, fallback: string) =>
	stderr
		.split("\n")
		.map((line) => line.trim())
		.find(Boolean) ?? fallback

interface PullRequestQuery {
	readonly remoteUrl: string | null
	readonly remoteRepository: string
	readonly result:
		| {
				readonly exitCode: number
				readonly stdout: string
				readonly stderr: string
		  }
		| undefined
}

const mergedPullRequestFromGitHub = (
	data: ExecutionData,
	query: PullRequestQuery | undefined,
) => {
	if (!query?.result || query.result.exitCode !== 0) return null
	const existing = data.pr ? normalizePullRequestRecord(data.pr) : null
	const details = existing
		? [parseJson<Record<string, unknown>>(query.result.stdout, {})]
		: parseJson<Record<string, unknown>[]>(query.result.stdout, []).filter(
				(item) =>
					item.headRefName === data.branch && item.baseRefName === data.base,
			)
	if (details.length !== 1) return null
	const current = recordFromGitHubJson(details[0]!)
	if (
		current.merged !== true ||
		current.headRepository?.toLowerCase() !==
			query.remoteRepository.toLowerCase() ||
		current.headBranch !== data.branch ||
		current.baseRepository?.toLowerCase() !==
			current.repository.toLowerCase() ||
		current.baseBranch !== data.base
	) {
		return null
	}
	return current
}

const mutateExecution = (
	root: string,
	record: ExecutionRecord,
	revision: string,
	data: ExecutionData,
) => {
	const parsed = parseFrontmatterSync(record.content, record.path)
	const content = formatMarkdownDocument(data, parsed.body)
	return runLifecycleTransaction({
		root,
		preconditions: [{ path: record.path, revision }],
		steps: [documentWriteStep(root, [{ path: record.path, content }])],
	}).pipe(
		Effect.as({ data, revision: documentRevision(content) }),
		Effect.catchTag("LifecycleTransactionError", (error) =>
			Effect.fail(new SyncError({ message: error.message })),
		),
	)
}

export class SyncService extends Effect.Service<SyncService>()("SyncService", {
	sync: () => ({
		reconcile: (
			options: {
				readonly cwd?: string
				readonly apply?: boolean
				readonly onProgress?: (progress: SyncProgress) => void
				readonly taskId?: string
				readonly phaseId?: string
			} = {},
		) =>
			Effect.gen(function* () {
				const fs = yield* FileSystemService
				const workbase = yield* WorkbaseService
				const worktrees = yield* WorktreeService
				const repositories = yield* RepositoryService
				const versionControl = yield* VersionControlService
				const { root, config } = yield* workbase.loadConfig(options.cwd)
				const backend = yield* versionControl.forWorkbase(root)
				const validation = yield* workbase.validate(root, {
					includeDocuments: true,
				})
				if (!validation.valid) {
					return yield* new SyncError({
						message: validation.issues
							.map((issue) => `${issue.path}: ${issue.message}`)
							.join("\n"),
					})
				}
				if (options.phaseId && !options.taskId) {
					return yield* new SyncError({
						message: "A phase sync scope requires a task ID",
					})
				}
				const documents = validation.documents!
				const allTaskRecords = documents.tasks
				const taskRecords = options.taskId
					? allTaskRecords.filter((task) => task.id === options.taskId)
					: allTaskRecords
				if (options.taskId && taskRecords.length === 0) {
					return yield* new SyncError({
						message: `Task '${options.taskId}' does not exist`,
					})
				}
				const records: ExecutionRecord[] = []
				for (const task of taskRecords) {
					if ("phases" in task.data) {
						for (const phase of documents.phasesByTask.get(task.id) ?? []) {
							if (options.phaseId && phase.id !== options.phaseId) continue
							records.push({
								key: `phase:${task.id}/${phase.id}`,
								taskId: task.id,
								phaseId: phase.id,
								path: phase.path,
								content: phase.content,
								revision: phase.revision,
								data: phase.data,
							})
						}
					} else if (!options.phaseId && !("review" in task.data)) {
						records.push({
							key: `task:${task.id}`,
							taskId: task.id,
							path: task.path,
							content: task.content,
							revision: task.revision,
							data: task.data,
						})
					}
				}
				const reviewRecords = options.phaseId
					? []
					: taskRecords.filter((task) => "review" in task.data)
				if (options.phaseId && records.length === 0) {
					return yield* new SyncError({
						message: `Phase '${options.taskId}/${options.phaseId}' does not exist`,
					})
				}
				const repositoryAliases = new Set<string>()
				for (const record of records) {
					repositoryAliases.add(record.data.repo)
					for (const reference of record.data.repos ?? [])
						repositoryAliases.add(reference.repo)
				}
				for (const task of reviewRecords) {
					if ("review" in task.data)
						repositoryAliases.add(task.data.review.repo)
				}
				const repositorySetup = yield* repositories.setup({
					cwd: root,
					apply: options.apply === true,
					...(options.taskId ? { aliases: [...repositoryAliases] } : {}),
				})
				options.onProgress?.({
					stage: "repositories",
					current: repositorySetup.repositories.length,
					total: repositorySetup.repositories.length,
				})

				const apply = options.apply === true
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
				const registeredByRepository = new Map<
					string,
					RegisteredWorktree[] | null
				>()
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
				const listRegistered = (repositoryPath: string) =>
					Effect.gen(function* () {
						if (registeredByRepository.has(repositoryPath))
							return registeredByRepository.get(repositoryPath)!
						const listed = yield* Effect.either(
							backend.listWorkspaces(repositoryPath),
						)
						if (Either.isLeft(listed)) {
							registeredByRepository.set(repositoryPath, null)
							return null
						}
						const registered: RegisteredWorktree[] = []
						for (const item of listed.right) {
							registered.push({
								head: item.commit,
								branch: item.branch,
								path: (yield* fs.exists(item.path))
									? yield* fs.realPath(item.path)
									: resolve(item.path),
								...(item.dirty === undefined ? {} : { dirty: item.dirty }),
							})
						}
						registeredByRepository.set(repositoryPath, registered)
						return registered
					})
				const queryRecords = records.filter((record) => !record.data.completion)
				let queriedPullRequests = 0
				const remoteName = config.delivery?.remote ?? "origin"
				const repositoryPaths = [
					...new Set(
						queryRecords.map((record) => join(root, "repos", record.data.repo)),
					),
				]
				const remoteUrls = new Map(
					yield* Effect.forEach(
						repositoryPaths,
						(repositoryPath) =>
							backend
								.remoteUrl(repositoryPath, remoteName)
								.pipe(
									Effect.map(
										(remoteUrl) => [repositoryPath, remoteUrl] as const,
									),
								),
						{ concurrency: 8 },
					),
				)
				const prQueries = new Map(
					yield* Effect.forEach(
						queryRecords,
						(record) =>
							Effect.gen(function* () {
								const data = record.data
								const repositoryPath = join(root, "repos", data.repo)
								const remoteUrl = remoteUrls.get(repositoryPath) ?? null
								const remoteRepository = (remoteUrl ?? "")
									.trim()
									.replace(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?[^/]+\//i, "")
									.replace(/^[^:]+:/, "")
									.replace(/\.git\/?$/, "")
									.replace(/\/$/, "")
								const existing = data.pr
									? normalizePullRequestRecord(data.pr)
									: null
								let result
								if (config.delivery && remoteUrl) {
									const resolved = resolveDeliveryCommand(
										config.delivery,
										"query",
										{
											repository: remoteRepository,
											branch: data.branch,
											base: data.base,
											draft: existing ? String(existing.draft) : "",
											url: existing?.url ?? "",
											identifier: existing?.identifier ?? "",
										},
									)
									result = yield* runExternal(resolved.argv, {
										cwd: repositoryPath,
										env: resolved.environment,
									})
								} else if (!config.delivery && existing) {
									result = yield* runExternal(
										[
											"gh",
											"pr",
											"view",
											existing.url,
											"--json",
											GITHUB_PR_FIELDS,
										],
										{
											cwd: repositoryPath,
											env: {},
										},
									)
								} else if (!config.delivery) {
									result = yield* runExternal(
										[
											"gh",
											"pr",
											"list",
											"--repo",
											remoteRepository,
											"--head",
											data.branch,
											"--state",
											"all",
											"--json",
											GITHUB_PR_FIELDS,
										],
										{
											cwd: repositoryPath,
											env: {},
										},
									)
								}
								return [
									record.key,
									{ remoteUrl, remoteRepository, result },
								] as const
							}).pipe(
								Effect.tap(() =>
									Effect.sync(() => {
										queriedPullRequests += 1
										options.onProgress?.({
											stage: "pull-requests",
											current: queriedPullRequests,
											total: queryRecords.length,
											target: record.key,
										})
									}),
								),
							),
						{ concurrency: 8 },
					),
				)
				const reviewSourceQueries = new Map(
					yield* Effect.forEach(
						reviewRecords,
						(task) =>
							Effect.gen(function* () {
								if (!("review" in task.data)) return [task.id, null] as const
								const repositoryPath = join(
									root,
									"repos",
									task.data.review.repo,
								)
								const remote = yield* backend.remoteUrl(
									repositoryPath,
									"origin",
								)
								const source = yield* runExternal([
									"git",
									"ls-remote",
									remote ?? "origin",
									task.data.review.source.kind === "pull-request"
										? task.data.review.source.fetchRef
										: originRef(task.data.review.source.ref),
								])
								return [task.id, source] as const
							}),
						{ concurrency: 8 },
					),
				)
				const executionTotal = records.length + reviewRecords.length
				let reconciledExecutions = 0
				const reportExecution = (target: string) => {
					reconciledExecutions += 1
					options.onProgress?.({
						stage: "executions",
						current: reconciledExecutions,
						total: executionTotal,
						target,
					})
				}
				const checkoutRecords = records.filter((record) => {
					if (record.data.completion) return false
					const merged = config.delivery
						? null
						: mergedPullRequestFromGitHub(
								record.data,
								prQueries.get(record.key),
							)
					return merged === null || record.data.claim?.state === "active"
				})
				const checkoutCandidates = checkoutRecords.flatMap((record) => {
					const codePath = join(dirname(record.path), "code")
					return [
						{ repo: record.data.repo, path: join(codePath, record.data.repo) },
						...(record.data.repos ?? []).map((reference) => ({
							repo: reference.repo,
							path: join(codePath, reference.repo),
						})),
					]
				})
				const checkoutRepositoryPaths = [
					...new Set(
						checkoutCandidates.map(({ repo }) => join(root, "repos", repo)),
					),
				]
				yield* Effect.forEach(checkoutRepositoryPaths, listRegistered, {
					concurrency: 8,
				})
				const dirtyByCheckoutPath = new Map<string, boolean | null>()
				yield* Effect.forEach(
					checkoutCandidates,
					({ repo, path }) =>
						Effect.gen(function* () {
							if (!(yield* fs.isDirectory(path))) return
							const repositoryPath = join(root, "repos", repo)
							const registered = registeredByRepository.get(repositoryPath)
							if (!registered) return
							const expectedPath = yield* fs.realPath(path)
							const atPath = registered.find(
								(item) => item.path === expectedPath,
							)
							if (!atPath) return
							dirtyByCheckoutPath.set(
								path,
								atPath.dirty ?? (yield* backend.workspaceDirty(path)),
							)
						}),
					{ concurrency: 8 },
				)

				for (const record of records.sort((a, b) =>
					a.key.localeCompare(b.key),
				)) {
					let data = record.data
					let revision = record.revision
					const codePath = join(dirname(record.path), "code")
					const checkoutStates: CheckoutState[] = []
					const query = prQueries.get(record.key)
					const remoteMergedPr = config.delivery
						? null
						: mergedPullRequestFromGitHub(data, query)
					const skipCheckoutReconciliation =
						Boolean(data.completion) || remoteMergedPr !== null
					let materialize = false
					let workspaceConflict = false
					const declared: readonly (
						| { readonly repo: string; readonly branch: string }
						| RepositoryReference
					)[] = [
						{ repo: data.repo, branch: data.branch },
						...(data.repos ?? []),
					]

					for (const checkout of skipCheckoutReconciliation ? [] : declared) {
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
						const registered = yield* listRegistered(repositoryPath)
						if (registered === null) {
							unresolved.push({
								kind: "worktree-inspection-failed",
								target: record.key,
								message: `Cannot inspect '${checkout.repo}'`,
							})
							workspaceConflict = true
							continue
						}
						const exists = yield* fs.isDirectory(checkoutPath)
						const expectedPath = exists
							? yield* fs.realPath(checkoutPath)
							: (yield* fs.isDirectory(codePath))
								? join(yield* fs.realPath(codePath), checkout.repo)
								: resolve(checkoutPath)
						const atPath = registered.find((item) => item.path === expectedPath)
						const branchRef =
							"branch" in checkout ? `refs/heads/${checkout.branch}` : null
						const branchElsewhere = branchRef
							? registered.find(
									(item) =>
										item.branch === branchRef && item.path !== expectedPath,
								)
							: undefined
						if ("branch" in checkout && !exists && !branchElsewhere) {
							const branch = yield* backend.resolveRevision(
								repositoryPath,
								checkout.branch,
							)
							if (!branch) {
								const base = yield* backend.resolveRevision(
									repositoryPath,
									data.base,
								)
								if (!base) {
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
								const remote = yield* backend.remoteUrl(
									repositoryPath,
									"origin",
								)
								const remoteRef = remote
									? yield* runExternal([
											"git",
											"ls-remote",
											remote,
											originRef(checkout.ref),
										])
									: { exitCode: -1, stdout: "", stderr: "origin unavailable" }
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
							resolvedCommit ??= yield* backend.resolveRevision(
								repositoryPath,
								checkout.ref,
							)
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

						const dirty =
							exists && atPath
								? atPath.dirty !== undefined
									? atPath.dirty
									: dirtyByCheckoutPath.has(checkoutPath)
										? dirtyByCheckoutPath.get(checkoutPath)!
										: yield* backend.workspaceDirty(checkoutPath)
								: null
						if (exists && atPath && dirty === null) {
							warnings.push({
								kind: "status-inspection-failed",
								target: record.key,
								message: `Could not inspect dirtiness for ${checkoutPath}`,
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
								const repositoryPath = join(root, "repos", checkout.repo)
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
									const cached = registeredByRepository.get(repositoryPath)
									if (cached) {
										cached.push({
											path: yield* fs.realPath(checkout.path),
											head: checkout.resolvedCommit,
											branch:
												checkout.kind === "writable"
													? `refs/heads/${checkout.requestedRef}`
													: null,
											dirty: false,
										})
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

					if (data.completion) {
						executions.push({
							target: record.key,
							status: data.status,
							branch: data.branch,
							base: data.base,
							checkouts: checkoutStates,
							pr: { url: null, state: "none" },
						})
						reportExecution(record.key)
						continue
					}

					const existing = data.pr ? normalizePullRequestRecord(data.pr) : null
					let current: PullRequestRecord | null = existing
					let pr: Record<string, unknown> = existing ?? {
						url: null,
						state: "none",
					}
					let prConflict = false
					if (!query) {
						return yield* new SyncError({
							message: `Missing pull request query for '${record.key}'`,
						})
					}
					const { remoteUrl, remoteRepository } = query

					if (config.delivery && !remoteUrl) {
						warnings.push({
							kind: "delivery-remote-unavailable",
							target: record.key,
							message: `Could not inspect delivery remote '${remoteName}'`,
						})
					} else if (config.delivery) {
						const queried = query.result!
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
									(
										parsed.right.headRepository ?? parsed.right.repository
									).toLowerCase() !== remoteRepository.toLowerCase())
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
								message: commandErrorSummary(
									queried.stderr,
									"Could not query delivery provider",
								),
							})
						}
					} else if (existing) {
						const viewed = query.result!
						if (viewed.exitCode === 0) {
							const detail = parseJson<Record<string, unknown>>(
								viewed.stdout,
								{},
							)
							current = recordFromGitHubJson(detail)
							pr = { ...detail, ...current }
							if (
								current.headRepository?.toLowerCase() !==
									remoteRepository.toLowerCase() ||
								current.headBranch !== data.branch ||
								current.baseRepository?.toLowerCase() !==
									current.repository.toLowerCase() ||
								current.baseBranch !== data.base
							) {
								prConflict = true
								unresolved.push({
									kind: "pr-repository-conflict",
									target: record.key,
									message: `Recorded PR head does not match '${remoteRepository}:${data.branch}' or base '${current.repository}:${data.base}'`,
									action: "Correct the declaration or recorded PR URL",
								})
							}
						} else {
							pr = { url: existing.url, state: "unavailable" }
							warnings.push({
								kind: "pr-unavailable",
								target: record.key,
								message: `Could not inspect ${existing.url}: ${commandErrorSummary(viewed.stderr, "GitHub query failed")}`,
							})
						}
					} else {
						const listed = query.result!
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
								if (
									current.headRepository?.toLowerCase() !==
										remoteRepository.toLowerCase() ||
									current.baseRepository?.toLowerCase() !==
										current.repository.toLowerCase()
								) {
									prConflict = true
									unresolved.push({
										kind: "pr-repository-conflict",
										target: record.key,
										message: `Discovered PR repositories do not match writable repository '${remoteRepository}' and base '${current.repository}'`,
										action: "Record the authoritative PR URL manually",
									})
								}
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
								message: commandErrorSummary(
									listed.stderr,
									"Could not discover pull requests",
								),
							})
						}
					}

					if (current && JSON.stringify(current) !== JSON.stringify(existing)) {
						if (apply) {
							const recorded = yield* mutateExecution(root, record, revision, {
								...data,
								pr: current,
							})
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
						if (apply) {
							const completed = yield* mutateExecution(root, record, revision, {
								...data,
								status: "done",
							})
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

					executions.push({
						target: record.key,
						status: data.status,
						branch: data.branch,
						base: data.base,
						checkouts: checkoutStates,
						pr,
					})
					reportExecution(record.key)
				}

				for (const task of reviewRecords) {
					if (!("review" in task.data)) continue
					const data = task.data
					const inspection = yield* worktrees.inspect(task.id, undefined, root)
					for (const conflict of inspection.conflicts) {
						unresolved.push({
							kind: conflict.kind,
							target: `task:${task.id}`,
							message: conflict.message,
							action: "Repair or remove the review checkout explicitly",
						})
					}
					const checkout = inspection.checkouts[0]
					if (
						!checkout?.exists &&
						inspection.conflicts.length === 0 &&
						(data.status === "working" || data.status === "delegated")
					) {
						if (apply) yield* worktrees.materialize(task.id, undefined, root)
						changes.push({
							kind: "materialize-workspace",
							target: `task:${task.id}`,
							message: `Materialize pinned review checkout under ${inspection.codePath}`,
							status: apply ? "applied" : "planned",
						})
					}
					const source = reviewSourceQueries.get(task.id)
					const sourceCommit = source?.stdout.trim().split(/\s+/)[0] || null
					if (!sourceCommit) {
						warnings.push({
							kind: "review-source-unavailable",
							target: `task:${task.id}`,
							message:
								"Review source is unavailable; the pinned commit is unchanged",
						})
					}
					executions.push({
						target: `task:${task.id}`,
						status: data.status,
						branch: null,
						base: null,
						checkouts: checkout
							? [
									{
										repo: checkout.repo,
										kind: "reference",
										path: checkout.path,
										requestedRef: data.review.commit,
										resolvedCommit: checkout.expectedCommit,
										registered: checkout.registered,
										exists: checkout.exists,
										head: checkout.actualCommit,
										branch: checkout.actualBranch,
										dirty: checkout.dirty,
									},
								]
							: [],
						pr: { url: null, state: "none" },
						review: {
							pinnedCommit: data.review.commit,
							sourceCommit,
							sourceAvailable: sourceCommit !== null,
						},
					})
					reportExecution(`task:${task.id}`)
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
