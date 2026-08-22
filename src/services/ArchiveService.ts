import { Schema, TreeFormatter } from "@effect/schema"
import { Data, Effect, Either, Layer } from "effect"
import { lstat, mkdir, open, rename, rm } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import { EpicService, type EpicRecord } from "./EpicService"
import { FileSystemService } from "./FileSystemService"
import { PhaseService, type PhaseRecord } from "./PhaseService"
import { TaskService } from "./TaskService"
import { WorkbaseService } from "./WorkbaseService"
import {
	WorktreeService,
	type WorktreeRemovalSnapshot,
} from "./WorktreeService"
import {
	GitVersionControlService,
	VersionControlService,
} from "./VersionControlService"
import {
	formatMarkdownDocument,
	parseFrontmatter,
} from "../workbase/frontmatter"
import {
	EpicFrontmatter,
	Dependency,
	PhaseFrontmatter,
	TaskFrontmatter,
	type Dependency as DependencyData,
	type EpicFrontmatter as EpicData,
	type PhaseFrontmatter as PhaseData,
	type TaskFrontmatter as TaskData,
} from "../workbase/schemas"
import { validateDependencies } from "../workbase/dependency-graph"
import {
	archivedEpicDirectory,
	archivedPhaseDirectory,
	archivedTaskDirectory,
	lifecycleManifestPath,
} from "../workbase/archive"
import {
	directoryMoveStep,
	documentWriteStep,
	runLifecycleTransaction,
	type TransactionStep,
} from "./LifecycleTransaction"
import { withWorktreeLocks } from "./WorktreeLock"
import { aggregateProgress, isTerminalStatus } from "../readiness"

class ArchiveError extends Data.TaggedError("ArchiveError")<{
	readonly message: string
	readonly cause?: unknown
}> {}

export type ArchiveKind = "epic" | "task" | "phase"

const LifecycleEventSchema = Schema.Struct({
	operation: Schema.Literal("archive", "restore"),
	at: Schema.String,
	from: Schema.String,
	to: Schema.String,
})

const LifecycleManifestSchema = Schema.Struct({
	version: Schema.Literal(1),
	kind: Schema.Literal("epic", "task", "phase"),
	id: Schema.String,
	taskId: Schema.optional(Schema.String),
	parent: Schema.optional(
		Schema.Struct({
			kind: Schema.Literal("epic", "task"),
			id: Schema.String,
			declaration: Dependency,
		}),
	),
	history: Schema.Array(LifecycleEventSchema),
})

type LifecycleEvent = Schema.Schema.Type<typeof LifecycleEventSchema>
type LifecycleManifest = Schema.Schema.Type<typeof LifecycleManifestSchema>

interface ArchivedRecord {
	readonly kind: ArchiveKind
	readonly id: string
	readonly taskId?: string
	readonly path: string
	readonly documentPath: string
	readonly content: string
	readonly data: EpicData | TaskData | PhaseData
	readonly provenance?: LifecycleManifest
}

interface LifecycleResult {
	readonly operation: "archive" | "restore"
	readonly kind: ArchiveKind
	readonly id: string
	readonly taskId?: string
	readonly path: string
	readonly affectedPaths: readonly string[]
	readonly removedWorktrees: readonly string[]
	readonly dryRun: boolean
	readonly at: string
}

interface LifecycleOptions {
	readonly dryRun?: boolean
}

type TaskArchiveSkipCode =
	| "non-terminal"
	| "active-claim"
	| "dirty-worktree"
	| "checkout-preflight-failed"
	| "retained-dependent"
	| "destination-exists"

interface TaskArchiveDisposition {
	readonly id: string
	readonly disposition: "archived" | "planned" | "skipped"
	readonly reason?: {
		readonly code: TaskArchiveSkipCode
		readonly details: readonly string[]
	}
	readonly path?: string
	readonly affectedPaths: readonly string[]
	readonly removedWorktrees: readonly string[]
}

interface BulkTaskArchiveResult {
	readonly operation: "archive"
	readonly kind: "tasks"
	readonly tasks: readonly TaskArchiveDisposition[]
	readonly affectedPaths: readonly string[]
	readonly removedWorktrees: readonly string[]
	readonly dryRun: boolean
	readonly at: string
}

export interface ArchiveFilters {
	readonly kinds?: readonly string[]
	readonly statuses?: readonly string[]
	readonly repositories?: readonly string[]
}

interface TaskRecord {
	readonly id: string
	readonly path: string
	readonly content: string
	readonly revision: string
	readonly data: TaskData
}

interface Move {
	readonly from: string
	readonly to: string
}

interface Write {
	readonly path: string
	readonly content: string
}

interface TaskArchiveContext {
	readonly task: TaskRecord
	readonly phases: readonly PhaseRecord[]
	readonly executionUnits: readonly { taskId: string; phaseId?: string }[]
	readonly terminal: boolean
	readonly terminalDetails: readonly string[]
	readonly activeClaims: readonly string[]
}

const loadTaskArchiveContext = (task: TaskRecord, root: string) =>
	Effect.gen(function* () {
		const phases = yield* PhaseService
		if (!("phases" in task.data)) {
			return {
				task,
				phases: [],
				executionUnits: [{ taskId: task.id }],
				terminal: isTerminalStatus(task.data.status),
				terminalDetails: [`status=${task.data.status}`],
				activeClaims:
					task.data.claim?.state === "active" ? [`task:${task.id}`] : [],
			} satisfies TaskArchiveContext
		}

		const phaseRecords: PhaseRecord[] = []
		for (const declaration of task.data.phases) {
			phaseRecords.push(yield* phases.show(task.id, declaration.id, root))
		}
		const statuses = phaseRecords.map((phase) => phase.data.status)
		const effectiveStatus = aggregateProgress(statuses).status
		return {
			task,
			phases: phaseRecords,
			executionUnits: phaseRecords.map((phase) => ({
				taskId: task.id,
				phaseId: phase.id,
			})),
			terminal: phaseRecords.length > 0 && isTerminalStatus(effectiveStatus),
			terminalDetails:
				phaseRecords.length === 0
					? ["multi-phase task has no phases"]
					: phaseRecords.map(
							(phase) => `phase:${phase.id}:status=${phase.data.status}`,
						),
			activeClaims: phaseRecords
				.filter((phase) => phase.data.claim?.state === "active")
				.map((phase) => `phase:${task.id}/${phase.id}`),
		} satisfies TaskArchiveContext
	})

const archiveEligibilityError = (context: TaskArchiveContext) => {
	if (!context.terminal) {
		return `Task '${context.task.id}' is not terminal (${context.terminalDetails.join(", ")}); only done or dropped tasks can be archived`
	}
	if (context.activeClaims.length > 0) {
		return `Task '${context.task.id}' has active claims (${context.activeClaims.join(", ")}); release or finish them before archiving`
	}
	return undefined
}

const executionPhaseId = (unit: { taskId: string; phaseId?: string }) =>
	unit.phaseId

const decode = <S extends Schema.Schema.AnyNoContext>(
	schema: S,
	input: unknown,
	label: string,
) => {
	const result = Schema.decodeUnknownEither(schema, {
		errors: "all",
		onExcessProperty: "error",
	})(input)
	return Either.isLeft(result)
		? Effect.fail(
				new ArchiveError({
					message: `Invalid archived ${label}: ${TreeFormatter.formatErrorSync(result.left)}`,
				}),
			)
		: Effect.succeed(result.right)
}

const readManifest = (directory: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystemService
		const path = lifecycleManifestPath(directory)
		if (!(yield* fs.exists(path))) return undefined
		const content = yield* fs.readFile(path)
		const input = yield* Effect.try({
			try: () => JSON.parse(content) as unknown,
			catch: (cause) =>
				new ArchiveError({
					message: `Invalid lifecycle provenance: ${path}`,
					cause,
				}),
		})
		const decoded = Schema.decodeUnknownEither(LifecycleManifestSchema, {
			errors: "all",
			onExcessProperty: "error",
		})(input)
		if (Either.isLeft(decoded)) {
			return yield* new ArchiveError({
				message: `Invalid lifecycle provenance ${path}: ${TreeFormatter.formatErrorSync(decoded.left)}`,
			})
		}
		return decoded.right
	})

const manifestFor = (
	existing: LifecycleManifest | undefined,
	entity: Omit<LifecycleManifest, "version" | "history">,
	event: LifecycleEvent,
): LifecycleManifest => ({
	version: 1,
	...entity,
	history: [...(existing?.history ?? []), event],
})

const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n"

const withLifecycleLock = <A, E, R>(
	root: string,
	operation: Effect.Effect<A, E, R>,
) => {
	const lockPath = join(root, ".agency-archive.lock")
	return Effect.acquireUseRelease(
		Effect.tryPromise({
			try: () => open(lockPath, "wx"),
			catch: (cause) =>
				new ArchiveError({
					message:
						"Another archive or restore operation is in progress; wait and retry",
					cause,
				}),
		}),
		() => operation,
		(lock) =>
			Effect.promise(async () => {
				await lock.close().catch(() => undefined)
				await rm(lockPath, { force: true }).catch(() => undefined)
			}),
	)
}

const applyMutation = (moves: readonly Move[], writes: readonly Write[]) =>
	Effect.tryPromise({
		try: async () => {
			const completedMoves: Move[] = []
			const completedWrites: {
				path: string
				existed: boolean
				content?: string
			}[] = []
			try {
				for (const move of moves) {
					await mkdir(dirname(move.to), { recursive: true })
					await rename(move.from, move.to)
					completedMoves.push(move)
				}
				for (const write of writes) {
					const file = Bun.file(write.path)
					const existed = await file.exists()
					completedWrites.push({
						path: write.path,
						existed,
						...(existed ? { content: await file.text() } : {}),
					})
					await Bun.write(write.path, write.content)
				}
			} catch (cause) {
				let rollbackCause: unknown
				for (const write of [...completedWrites].reverse()) {
					try {
						if (write.existed) await Bun.write(write.path, write.content!)
						else await rm(write.path, { force: true })
					} catch (error) {
						rollbackCause ??= error
					}
				}
				for (const move of [...completedMoves].reverse()) {
					try {
						await rename(move.to, move.from)
					} catch (error) {
						rollbackCause ??= error
					}
				}
				if (rollbackCause) {
					throw new ArchiveError({
						message:
							"Archive lifecycle rollback failed; manual recovery is required",
						cause: new AggregateError([cause, rollbackCause]),
					})
				}
				throw cause
			}
		},
		catch: (cause) =>
			cause instanceof ArchiveError
				? cause
				: new ArchiveError({
						message:
							"Archive lifecycle operation failed; changes were rolled back",
						cause,
					}),
	})

const WorktreeLayer = Layer.mergeAll(
	FileSystemService.Default,
	WorkbaseService.Default,
	GitVersionControlService.Default,
	VersionControlService.Default,
	TaskService.Default,
	PhaseService.Default,
	WorktreeService.Default,
)

const runWorktreeEffect = <A, E>(effect: Effect.Effect<A, E, any>) =>
	Effect.runPromise(
		effect.pipe(Effect.provide(WorktreeLayer)) as Effect.Effect<A, E, never>,
	)

const runGit = async (args: readonly string[]) => {
	const process = Bun.spawn([...args], { stdout: "pipe", stderr: "pipe" })
	const [exitCode, stdout, stderr] = await Promise.all([
		process.exited,
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
	])
	if (exitCode !== 0) throw new Error(stderr.trim() || args.join(" "))
	return stdout.trim()
}

const restoreWorktreeSnapshots = async (
	snapshots: readonly WorktreeRemovalSnapshot[],
) => {
	for (const snapshot of snapshots) {
		try {
			await lstat(snapshot.path)
			continue
		} catch {}
		await mkdir(dirname(snapshot.path), { recursive: true })
		await runGit(
			snapshot.branch
				? [
						"git",
						"-C",
						snapshot.repositoryPath,
						"worktree",
						"add",
						snapshot.path,
						snapshot.branch,
					]
				: [
						"git",
						"-C",
						snapshot.repositoryPath,
						"worktree",
						"add",
						"--detach",
						snapshot.path,
						snapshot.head,
					],
		)
	}
}

const rejectExistingDestination = (
	path: string,
	operation: "Archive" | "Restore",
) =>
	Effect.gen(function* () {
		const fs = yield* FileSystemService
		if (yield* fs.exists(path)) {
			return yield* new ArchiveError({
				message: `${operation} destination already exists: ${path}`,
			})
		}
	})

const event = (
	root: string,
	operation: LifecycleEvent["operation"],
	at: string,
	from: string,
	to: string,
): LifecycleEvent => ({
	operation,
	at,
	from: relative(root, from),
	to: relative(root, to),
})

const declarationContent = (
	record: { readonly content: string; readonly path: string },
	data: EpicData | TaskData,
) =>
	parseFrontmatter(record.content, record.path).pipe(
		Effect.map((parsed) => formatMarkdownDocument(data, parsed.body)),
	)

const repositoriesFor = (record: ArchivedRecord) => {
	if (record.kind === "epic") {
		return (record.data as EpicData).repos.map((reference) => reference.repo)
	}
	if ("repo" in record.data) {
		return [
			record.data.repo,
			...(record.data.repos ?? []).map((reference) => reference.repo),
		]
	}
	if ("review" in record.data) return [record.data.review.repo]
	return []
}

const statusFor = (record: ArchivedRecord) =>
	"status" in record.data ? record.data.status : undefined

export class ArchiveService extends Effect.Service<ArchiveService>()(
	"ArchiveService",
	{
		sync: () => ({
			list: (filters: ArchiveFilters = {}, startPath: string = process.cwd()) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const workbase = yield* WorkbaseService
					const root = yield* workbase.discover(startPath)
					const kinds = filters.kinds?.length
						? new Set(filters.kinds)
						: new Set<ArchiveKind>(["epic", "task", "phase"])
					for (const kind of kinds) {
						if (
							!(["epic", "task", "phase"] as const).includes(
								kind as ArchiveKind,
							)
						) {
							return yield* new ArchiveError({
								message: `Unknown archive kind '${kind}'`,
							})
						}
					}

					const records: ArchivedRecord[] = []
					const readRecord = (
						kind: ArchiveKind,
						id: string,
						directory: string,
						documentName: string,
						schema: Schema.Schema.AnyNoContext,
						taskId?: string,
					) =>
						Effect.gen(function* () {
							const documentPath = join(directory, documentName)
							if (!(yield* fs.exists(documentPath))) return
							const content = yield* fs.readFile(documentPath)
							const parsed = yield* parseFrontmatter(content, documentPath)
							const data = yield* decode(schema, parsed.data, `${kind} '${id}'`)
							const provenance = yield* readManifest(directory)
							if (
								provenance &&
								(provenance.kind !== kind ||
									provenance.id !== id ||
									(kind === "phase" && provenance.taskId !== taskId))
							) {
								return yield* new ArchiveError({
									message: `Lifecycle provenance does not match archived ${kind} '${id}'`,
								})
							}
							records.push({
								kind,
								id,
								...(taskId ? { taskId } : {}),
								path: directory,
								documentPath,
								content,
								data: data as EpicData | TaskData | PhaseData,
								...(provenance ? { provenance } : {}),
							})
						})

					if (kinds.has("epic")) {
						const directory = join(root, "archive", "epics")
						if (yield* fs.isDirectory(directory)) {
							for (const entry of yield* fs.readDirectory(directory)) {
								if (entry.isDirectory)
									yield* readRecord(
										"epic",
										entry.name,
										join(directory, entry.name),
										"EPIC.md",
										EpicFrontmatter,
									)
							}
						}
					}

					const tasksDirectory = join(root, "archive", "tasks")
					if (yield* fs.isDirectory(tasksDirectory)) {
						for (const taskEntry of yield* fs.readDirectory(tasksDirectory)) {
							if (!taskEntry.isDirectory) continue
							const taskDirectory = join(tasksDirectory, taskEntry.name)
							if (kinds.has("task")) {
								yield* readRecord(
									"task",
									taskEntry.name,
									taskDirectory,
									"TASK.md",
									TaskFrontmatter,
								)
							}
							if (!kinds.has("phase")) continue
							const phasesDirectory = join(taskDirectory, "phases")
							if (!(yield* fs.isDirectory(phasesDirectory))) continue
							for (const phaseEntry of yield* fs.readDirectory(
								phasesDirectory,
							)) {
								if (phaseEntry.isDirectory)
									yield* readRecord(
										"phase",
										phaseEntry.name,
										join(phasesDirectory, phaseEntry.name),
										"PHASE.md",
										PhaseFrontmatter,
										taskEntry.name,
									)
							}
						}
					}

					return records
						.filter(
							(record) =>
								!filters.statuses?.length ||
								filters.statuses.includes(statusFor(record) ?? ""),
						)
						.filter(
							(record) =>
								!filters.repositories?.length ||
								filters.repositories.some((repository) =>
									repositoriesFor(record).includes(repository),
								),
						)
						.sort((a, b) =>
							`${a.kind}:${a.taskId ?? ""}:${a.id}`.localeCompare(
								`${b.kind}:${b.taskId ?? ""}:${b.id}`,
							),
						)
				}),

			show: (
				kind: ArchiveKind,
				id: string,
				taskId: string | undefined,
				startPath: string = process.cwd(),
			) =>
				Effect.gen(function* () {
					const service = yield* ArchiveService
					const record = (yield* service.list(
						{ kinds: [kind] },
						startPath,
					)).find(
						(candidate) =>
							candidate.id === id &&
							(kind !== "phase" || candidate.taskId === taskId),
					)
					if (!record) {
						return yield* new ArchiveError({
							message:
								kind === "phase"
									? `Archived phase '${id}' does not exist on task '${taskId}'`
									: `Archived ${kind} '${id}' does not exist`,
						})
					}
					return record
				}),

			archiveEpic: (
				id: string,
				startPath: string = process.cwd(),
				options: LifecycleOptions = {},
			) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const workbase = yield* WorkbaseService
					const epics = yield* EpicService
					const tasks = yield* TaskService
					const worktrees = yield* WorktreeService
					const root = yield* workbase.discover(startPath)
					const epic = yield* epics.show(id, root)
					const taskRecords: TaskRecord[] = []
					for (const child of epic.data.tasks) {
						const task = yield* tasks.show(child.id, root)
						if (task.data.epic !== id) {
							return yield* new ArchiveError({
								message: `Task '${task.id}' does not reference epic '${id}'`,
							})
						}
						taskRecords.push(task)
					}
					const declared = new Set(epic.data.tasks.map((task) => task.id))
					const unlisted = (yield* tasks.list(root)).find(
						(task) => task.data.epic === id && !declared.has(task.id),
					)
					if (unlisted) {
						return yield* new ArchiveError({
							message: `Task '${unlisted.id}' references epic '${id}' but is not listed by it`,
						})
					}

					const destination = archivedEpicDirectory(root, id)
					yield* rejectExistingDestination(destination, "Archive")
					for (const task of taskRecords) {
						yield* rejectExistingDestination(
							archivedTaskDirectory(root, task.id),
							"Archive",
						)
					}

					const executionUnits: { taskId: string; phaseId?: string }[] = []
					const phaseRecords: PhaseRecord[] = []
					for (const task of taskRecords) {
						if ("claim" in task.data && task.data.claim?.state === "active") {
							return yield* new ArchiveError({
								message: `Task '${task.id}' has an active claim; release or finish it before archiving`,
							})
						}
						if ("phases" in task.data) {
							for (const phase of task.data.phases) {
								const record = yield* (yield* PhaseService).show(
									task.id,
									phase.id,
									root,
								)
								if (record.data.claim?.state === "active") {
									return yield* new ArchiveError({
										message: `Phase '${phase.id}' has an active claim; release or finish it before archiving`,
									})
								}
								phaseRecords.push(record)
								executionUnits.push({ taskId: task.id, phaseId: phase.id })
							}
						} else {
							executionUnits.push({ taskId: task.id })
						}
					}
					const removedWorktrees: string[] = []
					for (const unit of executionUnits) {
						removedWorktrees.push(
							...(yield* worktrees.remove(unit.taskId, unit.phaseId, root, {
								dryRun: true,
							})),
						)
					}

					const at = new Date().toISOString()
					const moves: Move[] = taskRecords.map((task) => ({
						from: dirname(task.path),
						to: archivedTaskDirectory(root, task.id),
					}))
					moves.push({ from: dirname(epic.path), to: destination })
					const writes: (Write & { create?: boolean })[] = []
					for (const task of taskRecords) {
						const target = archivedTaskDirectory(root, task.id)
						const manifestPath = lifecycleManifestPath(dirname(task.path))
						const declaration = epic.data.tasks.find(
							(child) => child.id === task.id,
						)!
						writes.push({
							path: manifestPath,
							create: !(yield* fs.exists(manifestPath)),
							content: json(
								manifestFor(
									yield* readManifest(dirname(task.path)),
									{
										kind: "task",
										id: task.id,
										parent: { kind: "epic", id, declaration },
									},
									event(root, "archive", at, dirname(task.path), target),
								),
							),
						})
					}
					const epicManifestPath = lifecycleManifestPath(dirname(epic.path))
					writes.push({
						path: epicManifestPath,
						create: !(yield* fs.exists(epicManifestPath)),
						content: json(
							manifestFor(
								yield* readManifest(dirname(epic.path)),
								{ kind: "epic", id },
								event(root, "archive", at, dirname(epic.path), destination),
							),
						),
					})
					if (!options.dryRun) {
						const snapshots: WorktreeRemovalSnapshot[] = []
						const steps: TransactionStep[] = [
							documentWriteStep(root, writes),
							{
								label: `remove worktrees for epic ${id}`,
								apply: async () => {
									try {
										for (const unit of executionUnits)
											await runWorktreeEffect(
												worktrees.remove(unit.taskId, unit.phaseId, root, {
													snapshots,
													lockHeld: true,
												}),
											)
									} catch (cause) {
										await restoreWorktreeSnapshots(snapshots)
										throw cause
									}
								},
								rollback: () => restoreWorktreeSnapshots(snapshots),
								manualRecovery: `Run agency work prepare for each execution unit in epic '${id}'`,
							},
						]
						for (const move of moves)
							steps.push(directoryMoveStep(root, move.from, move.to))
						yield* withLifecycleLock(
							root,
							withWorktreeLocks(
								root,
								executionUnits,
								runLifecycleTransaction({
									root,
									preconditions: [
										{ path: epic.path, revision: epic.revision },
										...taskRecords.map((task) => ({
											path: task.path,
											revision: task.revision,
										})),
										...phaseRecords.map((phase) => ({
											path: phase.path,
											revision: phase.revision,
										})),
									],
									steps,
								}),
							),
						)
					}
					return {
						operation: "archive",
						kind: "epic",
						id,
						path: destination,
						affectedPaths: moves.map((move) => move.to),
						removedWorktrees,
						dryRun: options.dryRun === true,
						at,
					} satisfies LifecycleResult
				}),

			archiveTasks: (
				startPath: string = process.cwd(),
				options: LifecycleOptions = {},
			) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const workbase = yield* WorkbaseService
					const epics = yield* EpicService
					const tasks = yield* TaskService
					const worktrees = yield* WorktreeService
					const root = yield* workbase.discover(startPath)
					const validation = yield* workbase.validate(root)
					if (!validation.valid) {
						return yield* new ArchiveError({
							message: `Cannot plan bulk task archive because the workbase is invalid:\n${validation.issues
								.map((issue) => `- ${issue.path}: ${issue.message}`)
								.join("\n")}`,
						})
					}

					const taskRecords = yield* tasks.list(root)
					const epicRecords = yield* epics.list(root)
					const epicById = new Map(epicRecords.map((epic) => [epic.id, epic]))
					const contexts = new Map<string, TaskArchiveContext>()
					const skipped = new Map<
						string,
						NonNullable<TaskArchiveDisposition["reason"]>
					>()
					const removedByTask = new Map<string, string[]>()

					for (const task of taskRecords) {
						const context = yield* loadTaskArchiveContext(task, root)
						contexts.set(task.id, context)
						if (!context.terminal) {
							skipped.set(task.id, {
								code: "non-terminal",
								details: context.terminalDetails,
							})
							continue
						}
						if (context.activeClaims.length > 0) {
							skipped.set(task.id, {
								code: "active-claim",
								details: context.activeClaims,
							})
							continue
						}
						const destination = archivedTaskDirectory(root, task.id)
						if (yield* fs.exists(destination)) {
							skipped.set(task.id, {
								code: "destination-exists",
								details: [destination],
							})
							continue
						}
					}

					for (const context of contexts.values()) {
						if (skipped.has(context.task.id)) continue
						const removed: string[] = []
						let preflightFailure: unknown
						for (const unit of context.executionUnits) {
							const result = yield* worktrees
								.remove(unit.taskId, executionPhaseId(unit), root, {
									dryRun: true,
									task: context.task,
									phase: unit.phaseId
										? context.phases.find((phase) => phase.id === unit.phaseId)
										: undefined,
								})
								.pipe(Effect.either)
							if (Either.isLeft(result)) {
								preflightFailure = result.left
								break
							}
							removed.push(...result.right)
						}
						if (preflightFailure) {
							if (
								typeof preflightFailure !== "object" ||
								preflightFailure === null ||
								!("_tag" in preflightFailure) ||
								preflightFailure._tag !== "WorktreeError"
							) {
								return yield* Effect.fail(preflightFailure)
							}
							const message =
								"message" in preflightFailure &&
								typeof preflightFailure.message === "string"
									? preflightFailure.message
									: "Managed checkout removal preflight failed"
							const conflicts =
								"conflicts" in preflightFailure &&
								Array.isArray(preflightFailure.conflicts)
									? preflightFailure.conflicts
									: []
							if (
								/^Failed to inspect worktrees/.test(message) ||
								conflicts.some(
									(conflict) =>
										typeof conflict === "object" &&
										conflict !== null &&
										"kind" in conflict &&
										conflict.kind === "inspection-failed",
								)
							) {
								return yield* Effect.fail(preflightFailure)
							}
							const dirty =
								/uncommitted changes|dirty/i.test(message) ||
								conflicts.some(
									(conflict) =>
										typeof conflict === "object" &&
										conflict !== null &&
										"dirty" in conflict &&
										conflict.dirty === true,
								)
							skipped.set(context.task.id, {
								code: dirty ? "dirty-worktree" : "checkout-preflight-failed",
								details: [message],
							})
							continue
						}
						removedByTask.set(context.task.id, [...new Set(removed)].sort())
					}

					const cohort = new Set(
						taskRecords
							.filter((task) => !skipped.has(task.id))
							.map((task) => task.id),
					)
					let changed = true
					while (changed) {
						changed = false
						for (const taskId of [...cohort].sort()) {
							const task = contexts.get(taskId)!.task
							if (!task.data.epic) continue
							const parent = epicById.get(task.data.epic)!
							const dependents = parent.data.tasks
								.filter((candidate) => candidate.dependsOn?.includes(taskId))
								.map((candidate) => candidate.id)
								.filter((dependent) => !cohort.has(dependent))
								.sort()
							if (dependents.length === 0) continue
							cohort.delete(taskId)
							skipped.set(taskId, {
								code: "retained-dependent",
								details: dependents,
							})
							changed = true
						}
					}

					const selected = [...cohort].sort().map((id) => contexts.get(id)!)
					const at = new Date().toISOString()
					const writes: (Write & { create?: boolean })[] = []
					const selectedByEpic = new Map<string, Set<string>>()
					for (const context of selected) {
						const epicId = context.task.data.epic
						if (!epicId) continue
						const ids = selectedByEpic.get(epicId) ?? new Set<string>()
						ids.add(context.task.id)
						selectedByEpic.set(epicId, ids)
					}
					for (const [epicId, ids] of [...selectedByEpic].sort(([a], [b]) =>
						a.localeCompare(b),
					)) {
						const parent = epicById.get(epicId)!
						const remaining = parent.data.tasks.filter(
							(task) => !ids.has(task.id),
						)
						const dependencyIssue = validateDependencies(remaining, "Tasks")
						if (dependencyIssue) {
							return yield* new ArchiveError({
								message: `Cannot archive task cohort from epic '${epicId}': ${dependencyIssue}`,
							})
						}
						writes.push({
							path: parent.path,
							content: yield* declarationContent(parent, {
								...parent.data,
								tasks: remaining,
							}),
						})
					}

					for (const context of selected) {
						const task = context.task
						const destination = archivedTaskDirectory(root, task.id)
						const parent = task.data.epic
							? epicById.get(task.data.epic)
							: undefined
						const declaration = parent?.data.tasks.find(
							(candidate) => candidate.id === task.id,
						)
						const manifestPath = lifecycleManifestPath(dirname(task.path))
						writes.push({
							path: manifestPath,
							create: !(yield* fs.exists(manifestPath)),
							content: json(
								manifestFor(
									yield* readManifest(dirname(task.path)),
									{
										kind: "task",
										id: task.id,
										...(parent && declaration
											? {
													parent: {
														kind: "epic" as const,
														id: parent.id,
														declaration,
													},
												}
											: {}),
									},
									event(root, "archive", at, dirname(task.path), destination),
								),
							),
						})
					}
					writes.sort((a, b) => a.path.localeCompare(b.path))

					const executionUnits = selected
						.flatMap((context) => context.executionUnits)
						.sort((a, b) =>
							`${a.taskId}/${a.phaseId ?? ""}`.localeCompare(
								`${b.taskId}/${b.phaseId ?? ""}`,
							),
						)
					if (!options.dryRun && selected.length > 0) {
						const snapshots: WorktreeRemovalSnapshot[] = []
						const steps: TransactionStep[] = [
							documentWriteStep(root, writes),
							{
								label: "remove worktrees for task archive cohort",
								apply: async () => {
									try {
										for (const unit of executionUnits) {
											await runWorktreeEffect(
												worktrees.remove(unit.taskId, unit.phaseId, root, {
													snapshots,
													lockHeld: true,
													task: contexts.get(unit.taskId)!.task,
													phase: unit.phaseId
														? contexts
																.get(unit.taskId)!
																.phases.find(
																	(phase) => phase.id === unit.phaseId,
																)
														: undefined,
												}),
											)
										}
									} catch (cause) {
										await restoreWorktreeSnapshots(snapshots)
										throw cause
									}
								},
								rollback: () => restoreWorktreeSnapshots(snapshots),
								manualRecovery:
									"Run agency work prepare for each archived execution unit",
							},
						]
						for (const context of selected) {
							steps.push(
								directoryMoveStep(
									root,
									dirname(context.task.path),
									archivedTaskDirectory(root, context.task.id),
								),
							)
						}
						const parentPreconditions = [...selectedByEpic.keys()]
							.sort()
							.map((id) => epicById.get(id)!)
							.map((epic) => ({ path: epic.path, revision: epic.revision }))
						yield* withLifecycleLock(
							root,
							withWorktreeLocks(
								root,
								executionUnits,
								runLifecycleTransaction({
									root,
									preconditions: [
										...parentPreconditions,
										...selected.flatMap((context) => [
											{
												path: context.task.path,
												revision: context.task.revision,
											},
											...context.phases.map((phase) => ({
												path: phase.path,
												revision: phase.revision,
											})),
										]),
									],
									steps,
								}),
							),
						)
					}

					const dispositions = taskRecords
						.map((task): TaskArchiveDisposition => {
							const reason = skipped.get(task.id)
							if (reason) {
								return {
									id: task.id,
									disposition: "skipped",
									reason,
									affectedPaths: [],
									removedWorktrees: [],
								}
							}
							const path = archivedTaskDirectory(root, task.id)
							const parentPath = task.data.epic
								? epicById.get(task.data.epic)?.path
								: undefined
							return {
								id: task.id,
								disposition: options.dryRun ? "planned" : "archived",
								path,
								affectedPaths: [
									path,
									...(parentPath ? [parentPath] : []),
								].sort(),
								removedWorktrees: removedByTask.get(task.id) ?? [],
							}
						})
						.sort((a, b) => a.id.localeCompare(b.id))
					return {
						operation: "archive",
						kind: "tasks",
						tasks: dispositions,
						affectedPaths: [
							...new Set(dispositions.flatMap((item) => item.affectedPaths)),
						].sort(),
						removedWorktrees: [
							...new Set(dispositions.flatMap((item) => item.removedWorktrees)),
						].sort(),
						dryRun: options.dryRun === true,
						at,
					} satisfies BulkTaskArchiveResult
				}),

			archiveTask: (
				id: string,
				startPath: string = process.cwd(),
				options: LifecycleOptions = {},
			) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const workbase = yield* WorkbaseService
					const epics = yield* EpicService
					const tasks = yield* TaskService
					const worktrees = yield* WorktreeService
					const root = yield* workbase.discover(startPath)
					const task = yield* tasks.show(id, root)
					const archiveContext = yield* loadTaskArchiveContext(task, root)
					const eligibilityError = archiveEligibilityError(archiveContext)
					if (eligibilityError) {
						return yield* new ArchiveError({
							message: eligibilityError,
						})
					}
					const destination = archivedTaskDirectory(root, id)
					yield* rejectExistingDestination(destination, "Archive")
					let parentEpic: EpicRecord | undefined
					let declaration: DependencyData | undefined
					if (task.data.epic) {
						parentEpic = yield* epics.show(task.data.epic, root)
						declaration = parentEpic.data.tasks.find((child) => child.id === id)
						if (!declaration) {
							return yield* new ArchiveError({
								message: `Epic '${task.data.epic}' does not declare task '${id}'`,
							})
						}
						const dependent = parentEpic.data.tasks.find((child) =>
							child.dependsOn?.includes(id),
						)
						if (dependent) {
							return yield* new ArchiveError({
								message: `Cannot archive task '${id}'; task '${dependent.id}' depends on it`,
							})
						}
					}

					const executionUnits = archiveContext.executionUnits
					const phaseRecords = archiveContext.phases
					const removedWorktrees: string[] = []
					for (const unit of executionUnits)
						removedWorktrees.push(
							...(yield* worktrees.remove(
								unit.taskId,
								executionPhaseId(unit),
								root,
								{
									dryRun: true,
								},
							)),
						)
					const at = new Date().toISOString()
					const writes: (Write & { create?: boolean })[] = []
					if (parentEpic) {
						writes.push({
							path: parentEpic.path,
							content: yield* declarationContent(parentEpic, {
								...parentEpic.data,
								tasks: parentEpic.data.tasks.filter((child) => child.id !== id),
							}),
						})
					}
					const manifestPath = lifecycleManifestPath(dirname(task.path))
					writes.push({
						path: manifestPath,
						create: !(yield* fs.exists(manifestPath)),
						content: json(
							manifestFor(
								yield* readManifest(dirname(task.path)),
								{
									kind: "task",
									id,
									...(task.data.epic && declaration
										? {
												parent: {
													kind: "epic" as const,
													id: task.data.epic,
													declaration,
												},
											}
										: {}),
								},
								event(root, "archive", at, dirname(task.path), destination),
							),
						),
					})
					if (!options.dryRun) {
						const snapshots: WorktreeRemovalSnapshot[] = []
						const steps: TransactionStep[] = [
							documentWriteStep(root, writes),
							{
								label: `remove worktrees for task ${id}`,
								apply: async () => {
									try {
										for (const unit of executionUnits)
											await runWorktreeEffect(
												worktrees.remove(
													unit.taskId,
													executionPhaseId(unit),
													root,
													{
														snapshots,
														lockHeld: true,
													},
												),
											)
									} catch (cause) {
										await restoreWorktreeSnapshots(snapshots)
										throw cause
									}
								},
								rollback: () => restoreWorktreeSnapshots(snapshots),
								manualRecovery: `Run agency work prepare for task '${id}'`,
							},
							directoryMoveStep(root, dirname(task.path), destination),
						]
						yield* withLifecycleLock(
							root,
							withWorktreeLocks(
								root,
								executionUnits,
								runLifecycleTransaction({
									root,
									preconditions: [
										{ path: task.path, revision: task.revision },
										...(parentEpic
											? [
													{
														path: parentEpic.path,
														revision: parentEpic.revision,
													},
												]
											: []),
										...phaseRecords.map((phase) => ({
											path: phase.path,
											revision: phase.revision,
										})),
									],
									steps,
								}),
							),
						)
					}
					return {
						operation: "archive",
						kind: "task",
						id,
						path: destination,
						affectedPaths: [destination],
						removedWorktrees,
						dryRun: options.dryRun === true,
						at,
					} satisfies LifecycleResult
				}),

			archivePhase: (
				taskId: string,
				id: string,
				startPath: string = process.cwd(),
				options: LifecycleOptions = {},
			) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const workbase = yield* WorkbaseService
					const tasks = yield* TaskService
					const phases = yield* PhaseService
					const worktrees = yield* WorktreeService
					const root = yield* workbase.discover(startPath)
					const task = yield* tasks.show(taskId, root)
					if (!("phases" in task.data)) {
						return yield* new ArchiveError({
							message: `Task '${taskId}' is single-phase and does not contain phases`,
						})
					}
					const phase = yield* phases.show(taskId, id, root)
					const declaration = task.data.phases.find(
						(candidate) => candidate.id === id,
					)!
					if (phase.data.claim?.state === "active") {
						return yield* new ArchiveError({
							message: `Phase '${id}' has an active claim; release or finish it before archiving`,
						})
					}
					const dependent = task.data.phases.find((candidate) =>
						candidate.dependsOn?.includes(id),
					)
					if (dependent) {
						return yield* new ArchiveError({
							message: `Cannot archive phase '${id}'; phase '${dependent.id}' depends on it`,
						})
					}
					const destination = archivedPhaseDirectory(root, taskId, id)
					yield* rejectExistingDestination(destination, "Archive")
					const removedWorktrees = yield* worktrees.remove(taskId, id, root, {
						dryRun: true,
					})
					const at = new Date().toISOString()
					const content = yield* declarationContent(task, {
						...task.data,
						phases: task.data.phases.filter((candidate) => candidate.id !== id),
					})
					const manifestPath = lifecycleManifestPath(dirname(phase.path))
					const writes: (Write & { create?: boolean })[] = [
						{ path: task.path, content },
						{
							path: manifestPath,
							create: !(yield* fs.exists(manifestPath)),
							content: json(
								manifestFor(
									yield* readManifest(dirname(phase.path)),
									{
										kind: "phase",
										id,
										taskId,
										parent: { kind: "task", id: taskId, declaration },
									},
									event(root, "archive", at, dirname(phase.path), destination),
								),
							),
						},
					]
					if (!options.dryRun) {
						const snapshots: WorktreeRemovalSnapshot[] = []
						yield* withLifecycleLock(
							root,
							withWorktreeLocks(
								root,
								[{ taskId, phaseId: id }],
								runLifecycleTransaction({
									root,
									preconditions: [
										{ path: task.path, revision: task.revision },
										{ path: phase.path, revision: phase.revision },
									],
									steps: [
										documentWriteStep(root, writes),
										{
											label: `remove worktrees for phase ${taskId}/${id}`,
											apply: async () => {
												await runWorktreeEffect(
													worktrees.remove(taskId, id, root, {
														snapshots,
														lockHeld: true,
													}),
												)
											},
											rollback: () => restoreWorktreeSnapshots(snapshots),
											manualRecovery: `Run agency work prepare for phase '${taskId}/${id}'`,
										},
										directoryMoveStep(root, dirname(phase.path), destination),
									],
								}),
							),
						)
					}
					return {
						operation: "archive",
						kind: "phase",
						id,
						taskId,
						path: destination,
						affectedPaths: [destination],
						removedWorktrees,
						dryRun: options.dryRun === true,
						at,
					} satisfies LifecycleResult
				}),

			restoreEpic: (
				id: string,
				startPath: string = process.cwd(),
				options: LifecycleOptions = {},
			) =>
				Effect.gen(function* () {
					const workbase = yield* WorkbaseService
					const epics = yield* EpicService
					const service = yield* ArchiveService
					const root = yield* workbase.discover(startPath)
					const epic = yield* service.show("epic", id, undefined, root)
					const epicData = epic.data as EpicData
					const destination = join(root, "epics", id)
					yield* rejectExistingDestination(destination, "Restore")
					const activeEpics = yield* epics.list(root)
					const tasks: ArchivedRecord[] = []
					for (const child of epicData.tasks) {
						const conflictingEpic = activeEpics.find((candidate) =>
							candidate.data.tasks.some(
								(declaration) => declaration.id === child.id,
							),
						)
						if (conflictingEpic) {
							return yield* new ArchiveError({
								message: `Active epic '${conflictingEpic.id}' already declares archived task '${child.id}'`,
							})
						}
						const task = yield* service.show("task", child.id, undefined, root)
						if ((task.data as TaskData).epic !== id) {
							return yield* new ArchiveError({
								message: `Archived task '${child.id}' does not backlink to epic '${id}'`,
							})
						}
						if (
							task.provenance?.parent &&
							(task.provenance.parent.kind !== "epic" ||
								task.provenance.parent.id !== id ||
								task.provenance.parent.declaration.id !== child.id)
						) {
							return yield* new ArchiveError({
								message: `Archived task '${child.id}' has conflicting epic provenance`,
							})
						}
						yield* rejectExistingDestination(
							join(root, "tasks", child.id),
							"Restore",
						)
						tasks.push(task)
					}
					const dependencyIssue = validateDependencies(
						epicData.tasks,
						`epic '${id}'`,
					)
					if (dependencyIssue)
						return yield* new ArchiveError({ message: dependencyIssue })
					const at = new Date().toISOString()
					const moves: Move[] = tasks.map((task) => ({
						from: task.path,
						to: join(root, "tasks", task.id),
					}))
					moves.push({ from: epic.path, to: destination })
					if (!options.dryRun) {
						const writes: Write[] = []
						for (const record of [...tasks, epic]) {
							const target =
								record.kind === "epic"
									? destination
									: join(root, "tasks", record.id)
							const manifest = manifestFor(
								record.provenance,
								{
									kind: record.kind,
									id: record.id,
									...(record.provenance?.parent
										? { parent: record.provenance.parent }
										: {}),
								},
								event(root, "restore", at, record.path, target),
							)
							writes.push({
								path: lifecycleManifestPath(target),
								content: json(manifest),
							})
						}
						yield* withLifecycleLock(root, applyMutation(moves, writes))
					}
					return {
						operation: "restore",
						kind: "epic",
						id,
						path: destination,
						affectedPaths: moves.map((move) => move.to),
						removedWorktrees: [],
						dryRun: options.dryRun === true,
						at,
					} satisfies LifecycleResult
				}),

			restoreTask: (
				id: string,
				startPath: string = process.cwd(),
				options: LifecycleOptions = {},
			) =>
				Effect.gen(function* () {
					const workbase = yield* WorkbaseService
					const epics = yield* EpicService
					const service = yield* ArchiveService
					const root = yield* workbase.discover(startPath)
					const task = yield* service.show("task", id, undefined, root)
					const taskData = task.data as TaskData
					const destination = join(root, "tasks", id)
					yield* rejectExistingDestination(destination, "Restore")
					const activeEpics = yield* epics.list(root)
					const conflictingEpic = activeEpics.find(
						(candidate) =>
							candidate.id !== taskData.epic &&
							candidate.data.tasks.some((declaration) => declaration.id === id),
					)
					if (conflictingEpic) {
						return yield* new ArchiveError({
							message: `Active epic '${conflictingEpic.id}' already declares archived task '${id}'`,
						})
					}
					if (!taskData.epic && task.provenance?.parent) {
						return yield* new ArchiveError({
							message: `Archived task '${id}' is missing its epic backlink`,
						})
					}
					let parent: EpicRecord | undefined
					let declaration: DependencyData | undefined
					if (taskData.epic) {
						parent = yield* epics.show(taskData.epic, root)
						if (
							task.provenance?.parent &&
							(task.provenance.parent.kind !== "epic" ||
								task.provenance.parent.id !== taskData.epic)
						) {
							return yield* new ArchiveError({
								message: `Archived task '${id}' has conflicting epic backlink provenance`,
							})
						}
						declaration = task.provenance?.parent?.declaration ?? { id }
						if (declaration.id !== id) {
							return yield* new ArchiveError({
								message: `Archived task '${id}' has a conflicting parent declaration ID '${declaration.id}'`,
							})
						}
						if (parent.data.tasks.some((child) => child.id === id)) {
							return yield* new ArchiveError({
								message: `Epic '${taskData.epic}' already declares task '${id}'`,
							})
						}
						const nodes = [...parent.data.tasks, declaration]
						const dependencyIssue = validateDependencies(
							nodes,
							`epic '${taskData.epic}'`,
						)
						if (dependencyIssue)
							return yield* new ArchiveError({ message: dependencyIssue })
					}
					const at = new Date().toISOString()
					if (!options.dryRun) {
						const writes: Write[] = [
							{
								path: lifecycleManifestPath(destination),
								content: json(
									manifestFor(
										task.provenance,
										{
											kind: "task",
											id,
											...(task.provenance?.parent
												? { parent: task.provenance.parent }
												: {}),
										},
										event(root, "restore", at, task.path, destination),
									),
								),
							},
						]
						if (parent && declaration) {
							writes.push({
								path: parent.path,
								content: yield* declarationContent(parent, {
									...parent.data,
									tasks: [...parent.data.tasks, declaration],
								}),
							})
						}
						yield* withLifecycleLock(
							root,
							applyMutation([{ from: task.path, to: destination }], writes),
						)
					}
					return {
						operation: "restore",
						kind: "task",
						id,
						path: destination,
						affectedPaths: [destination],
						removedWorktrees: [],
						dryRun: options.dryRun === true,
						at,
					} satisfies LifecycleResult
				}),

			restorePhase: (
				taskId: string,
				id: string,
				startPath: string = process.cwd(),
				options: LifecycleOptions = {},
			) =>
				Effect.gen(function* () {
					const workbase = yield* WorkbaseService
					const tasks = yield* TaskService
					const service = yield* ArchiveService
					const root = yield* workbase.discover(startPath)
					const task = yield* tasks.show(taskId, root)
					if (!("phases" in task.data)) {
						return yield* new ArchiveError({
							message: `Task '${taskId}' is single-phase and cannot receive a phase`,
						})
					}
					const phase = yield* service.show("phase", id, taskId, root)
					if (
						phase.provenance?.parent &&
						(phase.provenance.parent.kind !== "task" ||
							phase.provenance.parent.id !== taskId)
					) {
						return yield* new ArchiveError({
							message: `Archived phase '${id}' has conflicting task backlink provenance`,
						})
					}
					if (task.data.phases.some((candidate) => candidate.id === id)) {
						return yield* new ArchiveError({
							message: `Task '${taskId}' already declares phase '${id}'`,
						})
					}
					const destination = join(root, "tasks", taskId, "phases", id)
					yield* rejectExistingDestination(destination, "Restore")
					const declaration = phase.provenance?.parent?.declaration ?? { id }
					if (declaration.id !== id) {
						return yield* new ArchiveError({
							message: `Archived phase '${id}' has a conflicting parent declaration ID '${declaration.id}'`,
						})
					}
					const nodes = [...task.data.phases, declaration]
					const dependencyIssue = validateDependencies(
						nodes,
						`task '${taskId}'`,
					)
					if (dependencyIssue)
						return yield* new ArchiveError({ message: dependencyIssue })
					const at = new Date().toISOString()
					if (!options.dryRun) {
						yield* withLifecycleLock(
							root,
							applyMutation(
								[{ from: phase.path, to: destination }],
								[
									{
										path: task.path,
										content: yield* declarationContent(task, {
											...task.data,
											phases: [...task.data.phases, declaration],
										}),
									},
									{
										path: lifecycleManifestPath(destination),
										content: json(
											manifestFor(
												phase.provenance,
												{
													kind: "phase",
													id,
													taskId,
													...(phase.provenance?.parent
														? { parent: phase.provenance.parent }
														: {}),
												},
												event(root, "restore", at, phase.path, destination),
											),
										),
									},
								],
							),
						)
					}
					return {
						operation: "restore",
						kind: "phase",
						id,
						taskId,
						path: destination,
						affectedPaths: [destination],
						removedWorktrees: [],
						dryRun: options.dryRun === true,
						at,
					} satisfies LifecycleResult
				}),
		}),
	},
) {}
