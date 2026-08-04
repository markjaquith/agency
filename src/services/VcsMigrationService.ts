import { Data, Effect, Either } from "effect"
import { rename, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { documentRevision } from "../workbase/document-revision"
import type { WorkStatus } from "../workbase/schemas"
import {
	documentWriteStep,
	runLifecycleTransaction,
} from "./LifecycleTransaction"
import { FileSystemService } from "./FileSystemService"
import { PhaseService } from "./PhaseService"
import { RepositoryService } from "./RepositoryService"
import { TaskService } from "./TaskService"
import {
	GitVersionControlService,
	JjVersionControlService,
	type VersionControlBackend,
} from "./VersionControlService"
import { WorkbaseService } from "./WorkbaseService"
import { withWorktreeLocks, type WorktreeLockTarget } from "./WorktreeLock"
import { WorktreeService } from "./WorktreeService"

type VcsKind = "git" | "jj"

class VcsMigrationError extends Data.TaggedError("VcsMigrationError")<{
	readonly message: string
	readonly blockers?: readonly MigrationBlocker[]
}> {}

interface MigrationBlocker {
	readonly kind:
		| "active-work"
		| "dirty-workspace"
		| "workspace-conflict"
		| "repository"
		| "tool"
		| "jj-only-head"
	readonly target: string
	readonly message: string
}

interface WorkspacePlan {
	readonly taskId: string
	readonly phaseId?: string
	readonly repo: string
	readonly kind: "writable" | "reference"
	readonly path: string
	readonly head: string
	readonly branch: string | null
	readonly sourceName: string | null
	readonly targetName: string
	readonly previousBranchCommit: string | null
}

interface RepositoryPlan {
	readonly alias: string
	readonly path: string
	readonly target: string
	readonly kind: "bare" | "repository" | "symlink"
	readonly remote: string | null
}

interface MigrationState {
	readonly root: string
	readonly configured: VcsKind | null
	readonly source: VcsKind
	readonly target: VcsKind
	readonly available: { readonly git: boolean; readonly jj: boolean }
	readonly repositories: readonly {
		readonly alias: string
		readonly path: string
		readonly kind: "bare" | "repository" | "symlink" | null
		readonly initialized: boolean
	}[]
	readonly workspaceCount: number
	readonly blockers: readonly MigrationBlocker[]
}

interface MigrationResult extends MigrationState {
	readonly mode: "dry-run" | "apply"
	readonly actions: readonly string[]
}

const command = (
	fs: FileSystemService,
	args: readonly string[],
	label: string,
) =>
	fs.runCommand(args, { captureOutput: true }).pipe(
		Effect.flatMap((result) =>
			result.exitCode === 0
				? Effect.succeed(result.stdout.trim())
				: Effect.fail(
						new VcsMigrationError({
							message: `${label}: ${result.stderr.trim() || result.stdout.trim()}`,
						}),
					),
		),
	)

const runBackend = <A>(
	fs: FileSystemService,
	effect: Effect.Effect<A, unknown, any>,
) =>
	Effect.runPromise(
		effect.pipe(Effect.provideService(FileSystemService, fs)) as Effect.Effect<
			A,
			unknown,
			never
		>,
	)

const workspaceName = (plan: {
	readonly taskId: string
	readonly phaseId?: string
	readonly repo: string
}) => `agency-${plan.taskId}-${plan.phaseId ?? "task"}-${plan.repo}`

const createGitWorkspace = (
	fs: FileSystemService,
	plan: WorkspacePlan,
	repositoryPath: string,
) =>
	Effect.gen(function* () {
		if (plan.branch) {
			yield* command(
				fs,
				["git", "-C", repositoryPath, "branch", "-f", plan.branch, plan.head],
				`Failed to prepare branch '${plan.branch}'`,
			)
		}
		yield* command(
			fs,
			plan.branch
				? [
						"git",
						"-C",
						repositoryPath,
						"worktree",
						"add",
						plan.path,
						plan.branch,
					]
				: [
						"git",
						"-C",
						repositoryPath,
						"worktree",
						"add",
						"--detach",
						plan.path,
						plan.head,
					],
			`Failed to create Git worktree ${plan.path}`,
		)
	})

const restoreGitBranch = (
	fs: FileSystemService,
	plan: WorkspacePlan,
	repositoryPath: string,
) =>
	plan.branch
		? command(
				fs,
				plan.previousBranchCommit
					? [
							"git",
							"-C",
							repositoryPath,
							"branch",
							"-f",
							plan.branch,
							plan.previousBranchCommit,
						]
					: ["git", "-C", repositoryPath, "branch", "-D", plan.branch],
				`Failed to restore branch '${plan.branch}'`,
			).pipe(Effect.asVoid)
		: Effect.void

const executionRecords = (root: string) =>
	Effect.gen(function* () {
		const tasks = yield* TaskService
		const phases = yield* PhaseService
		const records: {
			taskId: string
			phaseId?: string
			status: WorkStatus
			claimActive: boolean
		}[] = []
		for (const task of yield* tasks.list(root)) {
			if ("phases" in task.data) {
				for (const phase of yield* phases.list(task.id, root)) {
					records.push({
						taskId: task.id,
						phaseId: phase.id,
						status: phase.data.status,
						claimActive: phase.data.claim?.state === "active",
					})
				}
			} else {
				records.push({
					taskId: task.id,
					status: task.data.status,
					claimActive: task.data.claim?.state === "active",
				})
			}
		}
		return records
	})

const inspectMigration = (startPath: string, requestedTarget?: VcsKind) =>
	Effect.gen(function* () {
		const fs = yield* FileSystemService
		const workbase = yield* WorkbaseService
		const repositories = yield* RepositoryService
		const worktrees = yield* WorktreeService
		const git = yield* GitVersionControlService
		const jj = yield* JjVersionControlService
		const { root, config } = yield* workbase.loadConfig(startPath)
		const source = config.vcs ?? "git"
		const target = requestedTarget ?? source
		const sourceBackend = source === "jj" ? jj : git
		const available = {
			git: Bun.which("git") !== null,
			jj: Bun.which("jj") !== null,
		}
		const blockers: MigrationBlocker[] = []
		if (!available.git) {
			blockers.push({
				kind: "tool",
				target: "git",
				message: "The git executable is required for VCS migration",
			})
		}
		if (target === "jj" && !available.jj) {
			blockers.push({
				kind: "tool",
				target: "jj",
				message: "The jj executable is required for migration to jj",
			})
		}

		const records = yield* executionRecords(root)
		for (const record of records) {
			if (record.claimActive) {
				const label = record.phaseId
					? `phase:${record.taskId}/${record.phaseId}`
					: `task:${record.taskId}`
				blockers.push({
					kind: "active-work",
					target: label,
					message: `${label} is active; finish or release it before migration`,
				})
			}
		}

		const repositoryRecords = yield* repositories.list(root)
		const repositoryPlans: RepositoryPlan[] = []
		const repositoryStatus: MigrationState["repositories"][number][] = []
		for (const repository of repositoryRecords) {
			const initialized = yield* fs.exists(
				join(
					repository.kind === "symlink"
						? yield* fs.realPath(repository.path)
						: repository.path,
					".jj",
				),
			)
			repositoryStatus.push({
				alias: repository.alias,
				path: repository.path,
				kind: repository.kind,
				initialized,
			})
			if (
				repository.kind === null ||
				repository.states.includes("missing") ||
				repository.states.includes("invalid")
			) {
				blockers.push({
					kind: "repository",
					target: `repository:${repository.alias}`,
					message: `Repository '${repository.alias}' must be valid and materialized before migration`,
				})
				continue
			}
			if (source === "jj" && !initialized) {
				blockers.push({
					kind: "repository",
					target: `repository:${repository.alias}`,
					message: `Repository '${repository.alias}' is not initialized for the configured jj backend`,
				})
			}
			const targetPath =
				repository.kind === "symlink"
					? yield* fs.realPath(repository.path)
					: repository.path
			repositoryPlans.push({
				alias: repository.alias,
				path: repository.path,
				target: targetPath,
				kind: repository.kind,
				remote: repository.declaredRemote ?? repository.remote,
			})
			if (source === "jj" && target === "git" && initialized) {
				const dirty = yield* sourceBackend.workspaceDirty(targetPath)
				if (dirty !== false) {
					blockers.push({
						kind: "dirty-workspace",
						target: `repository:${repository.alias}`,
						message: `Primary jj workspace for '${repository.alias}' must be clean`,
					})
				}
				const hiddenHeads = yield* command(
					fs,
					[
						"jj",
						"-R",
						targetPath,
						"log",
						"--ignore-working-copy",
						"--no-graph",
						"-r",
						"heads(all()) ~ (bookmarks() | remote_bookmarks() | working_copies())",
						"-T",
						'commit_id ++ "\\n"',
					],
					`Failed to inspect jj-only heads for '${repository.alias}'`,
				)
				if (hiddenHeads) {
					blockers.push({
						kind: "jj-only-head",
						target: `repository:${repository.alias}`,
						message: `Repository '${repository.alias}' has jj-only heads that are not preserved by bookmarks or workspaces`,
					})
				}
			}
		}

		const workspacePlans: WorkspacePlan[] = []
		const inspected = yield* Effect.either(worktrees.list(root))
		if (Either.isLeft(inspected)) {
			blockers.push({
				kind: "workspace-conflict",
				target: "workbase",
				message: "Managed workspaces could not be inspected",
			})
		} else {
			for (const inspection of inspected.right) {
				for (const checkout of inspection.checkouts) {
					if (checkout.conflicts.length > 0) {
						blockers.push({
							kind: "workspace-conflict",
							target: checkout.path,
							message: checkout.conflicts
								.map(({ message }) => message)
								.join("; "),
						})
						continue
					}
					if (!checkout.exists) continue
					if (checkout.dirty !== false) {
						blockers.push({
							kind: "dirty-workspace",
							target: checkout.path,
							message: `Workspace ${checkout.path} must be clean before migration`,
						})
						continue
					}
					if (!checkout.actualCommit || !checkout.registeredPath) {
						blockers.push({
							kind: "workspace-conflict",
							target: checkout.path,
							message: `Workspace ${checkout.path} has incomplete registration metadata`,
						})
						continue
					}
					const sourceName =
						source === "jj"
							? ((yield* sourceBackend.listWorkspaces(
									join(root, "repos", checkout.repo),
								)).find((item) => item.path === checkout.registeredPath)
									?.name ?? null)
							: null
					const previousBranchCommit = checkout.actualBranch
						? yield* command(
								fs,
								[
									"git",
									"-C",
									join(root, "repos", checkout.repo),
									"rev-parse",
									"--verify",
									`${checkout.actualBranch}^{commit}`,
								],
								`Failed to inspect branch '${checkout.actualBranch}'`,
							).pipe(Effect.catchAll(() => Effect.succeed(null)))
						: null
					workspacePlans.push({
						taskId: inspection.owner.taskId,
						...(inspection.owner.phaseId
							? { phaseId: inspection.owner.phaseId }
							: {}),
						repo: checkout.repo,
						kind: checkout.kind,
						path: checkout.path,
						head: checkout.actualCommit,
						branch: checkout.kind === "writable" ? checkout.requestedRef : null,
						sourceName,
						targetName: workspaceName({
							taskId: inspection.owner.taskId,
							phaseId: inspection.owner.phaseId,
							repo: checkout.repo,
						}),
						previousBranchCommit,
					})
				}
			}
		}

		const uniqueRepositoryPlans = [
			...new Map(repositoryPlans.map((plan) => [plan.target, plan])).values(),
		]
		return {
			state: {
				root,
				configured: config.vcs ?? null,
				source,
				target,
				available,
				repositories: repositoryStatus,
				workspaceCount: workspacePlans.length,
				blockers,
			} satisfies MigrationState,
			repositoryPlans: uniqueRepositoryPlans,
			workspacePlans,
			records,
			config,
			sourceBackend,
			targetBackend: target === "jj" ? jj : git,
		}
	})

export class VcsMigrationService extends Effect.Service<VcsMigrationService>()(
	"VcsMigrationService",
	{
		sync: () => ({
			status: (startPath: string = process.cwd()) =>
				inspectMigration(startPath).pipe(Effect.map(({ state }) => state)),

			migrate: (
				target: VcsKind,
				startPath: string = process.cwd(),
				options: { readonly apply?: boolean } = {},
			) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const inspected = yield* inspectMigration(startPath, target)
					const { state, repositoryPlans, workspacePlans, records, config } =
						inspected
					const actions = [
						...workspacePlans.map(
							(plan) =>
								`replace ${state.source} workspace with ${target} workspace at ${plan.path}`,
						),
						...repositoryPlans.map((plan) =>
							target === "jj"
								? `initialize jj repository ${plan.alias}`
								: `remove jj metadata from repository ${plan.alias}`,
						),
						`set workbase vcs to ${target}`,
					]
					if (state.source === target) {
						const explicit = config.vcs === target
						const sameBackendActions = explicit
							? []
							: [`set workbase vcs to ${target}`]
						if (options.apply && !explicit) {
							const configPath = join(state.root, "agency.json")
							const content = yield* fs.readFile(configPath)
							yield* runLifecycleTransaction({
								root: state.root,
								preconditions: [
									{ path: configPath, revision: documentRevision(content) },
								],
								steps: [
									documentWriteStep(state.root, [
										{
											path: configPath,
											content: `${JSON.stringify({ ...config, vcs: target }, null, 2)}\n`,
										},
									]),
								],
							})
						}
						return {
							...state,
							configured: options.apply ? target : state.configured,
							mode: options.apply ? "apply" : "dry-run",
							actions: sameBackendActions,
						} satisfies MigrationResult
					}
					if (!options.apply) {
						return {
							...state,
							mode: "dry-run",
							actions,
						} satisfies MigrationResult
					}
					if (state.blockers.length > 0) {
						return yield* new VcsMigrationError({
							message: state.blockers.map(({ message }) => message).join("\n"),
							blockers: state.blockers,
						})
					}
					const removedSource: WorkspacePlan[] = []
					const createdTarget: WorkspacePlan[] = []
					const repositoryBackups: {
						plan: RepositoryPlan
						kind: "swap" | "metadata"
						backup: string
					}[] = []
					const sourceBackend = inspected.sourceBackend
					const targetBackend = inspected.targetBackend
					const repositoryPath = (repo: string) =>
						join(state.root, "repos", repo)

					const removeWorkspace = async (
						backend: VersionControlBackend,
						plan: WorkspacePlan,
						name: string | null,
					) =>
						runBackend(
							fs,
							backend.removeWorkspace({
								repositoryPath: repositoryPath(plan.repo),
								workspacePath: plan.path,
								workspaceName: name,
							}),
						)
					const createWorkspace = async (
						backend: VersionControlBackend,
						plan: WorkspacePlan,
						name: string,
					) => {
						await fs.createDirectory(dirname(plan.path)).pipe(Effect.runPromise)
						if (backend.kind === "git") {
							await Effect.runPromise(
								createGitWorkspace(fs, plan, repositoryPath(plan.repo)),
							)
						} else {
							await runBackend(
								fs,
								backend.createWorkspace({
									repositoryPath: repositoryPath(plan.repo),
									workspacePath: plan.path,
									workspaceName: name,
									revision: plan.head,
									...(plan.branch ? { branch: plan.branch } : {}),
								}),
							)
						}
					}

					const configPath = join(state.root, "agency.json")
					const configContent = yield* fs.readFile(configPath)
					const targetConfig = `${JSON.stringify({ ...config, vcs: target }, null, 2)}\n`
					const migration = runLifecycleTransaction({
						root: state.root,
						preconditions: [
							{ path: configPath, revision: documentRevision(configContent) },
						],
						steps: [
							{
								label: `remove ${state.source} workspaces`,
								preflight: async () => {
									for (const plan of workspacePlans) {
										const dirty = await runBackend(
											fs,
											sourceBackend.workspaceDirty(plan.path),
										)
										const head = await runBackend(
											fs,
											sourceBackend.workspaceHead(plan.path),
										)
										if (dirty !== false || head !== plan.head)
											throw new Error(
												`Workspace ${plan.path} changed after migration inspection`,
											)
									}
								},
								apply: async () => {
									try {
										for (const plan of workspacePlans) {
											await removeWorkspace(
												sourceBackend,
												plan,
												plan.sourceName,
											)
											removedSource.push(plan)
										}
									} catch (cause) {
										for (const plan of [...removedSource].reverse())
											await createWorkspace(
												sourceBackend,
												plan,
												plan.sourceName ?? plan.targetName,
											)
										removedSource.length = 0
										throw cause
									}
								},
								rollback: async () => {
									for (const plan of [...removedSource].reverse())
										await createWorkspace(
											sourceBackend,
											plan,
											plan.sourceName ?? plan.targetName,
										)
								},
								manualRecovery: `Restore ${state.source} workspaces under the workbase task directories`,
							},
							{
								label: `convert repositories to ${target}`,
								apply: async () => {
									try {
										for (const plan of repositoryPlans) {
											if (target === "jj") {
												if (plan.kind === "bare") {
													const staging = `${plan.path}.agency-jj-staging`
													const backup = `${plan.path}.agency-git-backup`
													await rm(staging, { recursive: true, force: true })
													await Effect.runPromise(
														command(
															fs,
															["git", "clone", plan.path, staging],
															`Failed to convert repository '${plan.alias}'`,
														),
													)
													if (plan.remote)
														await Effect.runPromise(
															command(
																fs,
																[
																	"git",
																	"-C",
																	staging,
																	"remote",
																	"set-url",
																	"origin",
																	plan.remote,
																],
																`Failed to restore remote for '${plan.alias}'`,
															),
														)
													await runBackend(
														fs,
														targetBackend.initializeRepository(staging),
													)
													await rename(plan.path, backup)
													await rename(staging, plan.path)
													repositoryBackups.push({
														plan,
														kind: "swap",
														backup,
													})
												} else {
													await runBackend(
														fs,
														targetBackend.initializeRepository(plan.target),
													)
													const metadata = join(plan.target, ".jj")
													repositoryBackups.push({
														plan,
														kind: "metadata",
														backup: metadata,
													})
												}
											} else {
												const metadata = join(plan.target, ".jj")
												const backup = join(plan.target, ".agency-jj-backup")
												await rename(metadata, backup)
												repositoryBackups.push({
													plan,
													kind: "metadata",
													backup,
												})
											}
										}
									} catch (cause) {
										for (const backup of [...repositoryBackups].reverse()) {
											if (target === "jj") {
												if (backup.kind === "swap") {
													await rm(backup.plan.path, {
														recursive: true,
														force: true,
													})
													await rename(backup.backup, backup.plan.path)
												} else {
													await rm(backup.backup, {
														recursive: true,
														force: true,
													})
												}
											} else {
												await rename(
													backup.backup,
													join(backup.plan.target, ".jj"),
												)
											}
										}
										repositoryBackups.length = 0
										throw cause
									}
								},
								rollback: async () => {
									for (const backup of [...repositoryBackups].reverse()) {
										if (target === "jj") {
											if (backup.kind === "swap") {
												await rm(backup.plan.path, {
													recursive: true,
													force: true,
												})
												await rename(backup.backup, backup.plan.path)
											} else {
												await rm(backup.backup, {
													recursive: true,
													force: true,
												})
											}
										} else {
											await rename(
												backup.backup,
												join(backup.plan.target, ".jj"),
											)
										}
									}
								},
								finalize: async () => {
									for (const backup of repositoryBackups) {
										if (target === "jj" && backup.kind === "swap")
											await rm(backup.backup, { recursive: true, force: true })
										if (target === "git" && backup.kind === "metadata")
											await rm(backup.backup, { recursive: true, force: true })
									}
								},
								manualRecovery: `Restore repository backups under ${join(state.root, "repos")}`,
							},
							{
								label: `create ${target} workspaces`,
								apply: async () => {
									try {
										for (const plan of workspacePlans) {
											await createWorkspace(
												targetBackend,
												plan,
												plan.targetName,
											)
											createdTarget.push(plan)
										}
									} catch (cause) {
										for (const plan of [...createdTarget].reverse()) {
											await removeWorkspace(
												targetBackend,
												plan,
												target === "jj" ? plan.targetName : null,
											)
											if (target === "git")
												await Effect.runPromise(
													restoreGitBranch(fs, plan, repositoryPath(plan.repo)),
												)
										}
										createdTarget.length = 0
										throw cause
									}
								},
								rollback: async () => {
									for (const plan of [...createdTarget].reverse()) {
										await removeWorkspace(
											targetBackend,
											plan,
											target === "jj" ? plan.targetName : null,
										)
										if (target === "git")
											await Effect.runPromise(
												restoreGitBranch(fs, plan, repositoryPath(plan.repo)),
											)
									}
								},
								manualRecovery: `Remove partially created ${target} workspaces`,
							},
							documentWriteStep(state.root, [
								{ path: configPath, content: targetConfig },
							]),
						],
					})
					const lockTargets: WorktreeLockTarget[] = records.map((record) => ({
						taskId: record.taskId,
						...(record.phaseId ? { phaseId: record.phaseId } : {}),
					}))
					yield* withWorktreeLocks(state.root, lockTargets, migration)
					const current = yield* inspectMigration(state.root)
					return {
						...current.state,
						mode: "apply",
						actions,
					} satisfies MigrationResult
				}),
		}),
	},
) {}
