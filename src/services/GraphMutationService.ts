import { Schema, TreeFormatter } from "@effect/schema"
import { Data, Effect, Either } from "effect"
import { open, rename, rm } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import { EpicService, type EpicRecord } from "./EpicService"
import { FileSystemService } from "./FileSystemService"
import { PhaseService, type PhaseRecord } from "./PhaseService"
import { TaskService } from "./TaskService"
import { WorkbaseService } from "./WorkbaseService"
import {
	EntityId,
	EpicFrontmatter,
	PhaseFrontmatter,
	TaskFrontmatter,
	type Dependency,
	type EpicFrontmatter as EpicData,
	type PhaseFrontmatter as PhaseData,
	type RepositoryReference,
	type TaskFrontmatter as TaskData,
} from "../workbase/schemas"
import {
	formatMarkdownDocument,
	parseFrontmatter,
} from "../workbase/frontmatter"
import { validateDependencies } from "../workbase/dependency-graph"
import {
	documentRevision,
	RevisionConflictError,
} from "../workbase/document-revision"

class GraphMutationError extends Data.TaggedError("GraphMutationError")<{
	readonly message: string
	readonly cause?: unknown
}> {}

interface MutationResult {
	readonly operation: string
	readonly changed: boolean
	readonly entity: {
		readonly kind: "epic" | "task" | "phase"
		readonly id: string
	}
	readonly previousId?: string
	readonly changedPaths: readonly string[]
	readonly validation: {
		readonly valid: true
		readonly scope: readonly string[]
		readonly checks: readonly string[]
	}
}

interface WritePlan {
	readonly root: string
	readonly preconditions: readonly {
		readonly path: string
		readonly revision: string
	}[]
	readonly writes: readonly {
		readonly path: string
		readonly content: string
	}[]
	readonly move?: { readonly from: string; readonly to: string }
}

export interface EpicUpdates {
	readonly description?: string | null
	readonly ticketUrl?: string
	readonly repos?: readonly RepositoryReference[]
}

export interface TaskUpdates {
	readonly description?: string | null
	readonly ticketUrl?: string | null
	readonly repo?: string
	readonly repos?: readonly RepositoryReference[] | null
	readonly branch?: string
	readonly base?: string
	readonly pr?: string | null
}

export interface PhaseUpdates {
	readonly description?: string | null
	readonly repo?: string
	readonly repos?: readonly RepositoryReference[] | null
	readonly branch?: string
	readonly base?: string
	readonly pr?: string | null
}

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
				new GraphMutationError({
					message: `Invalid ${label}: ${TreeFormatter.formatErrorSync(result.left)}`,
				}),
			)
		: Effect.succeed(result.right)
}

const decodeId = (id: string, label: string) => {
	const decoded = Schema.decodeUnknownEither(EntityId)(id)
	return Either.isLeft(decoded)
		? Effect.fail(
				new GraphMutationError({ message: `Invalid ${label} ID '${id}'` }),
			)
		: Effect.succeed(decoded.right)
}

const exists = async (path: string) => {
	try {
		return await Bun.file(path).exists()
	} catch {
		return false
	}
}

const applyWritePlan = ({ root, preconditions, writes, move }: WritePlan) =>
	Effect.tryPromise({
		try: async () => {
			const lockPath = join(root, ".agency-graph-mutation.lock")
			let lock: Awaited<ReturnType<typeof open>> | undefined
			try {
				lock = await open(lockPath, "wx")
			} catch (cause) {
				throw new GraphMutationError({
					message:
						"Another graph mutation is in progress; wait for it to finish and retry",
					cause,
				})
			}

			const token = `${process.pid}-${Date.now()}`
			const staged = writes.map((write) => ({
				...write,
				stage: `${write.path}.${token}.stage`,
				backup: `${write.path}.${token}.backup`,
			}))
			const installed: typeof staged = []
			let moved = false
			let rollbackFailed = false
			try {
				for (const precondition of preconditions) {
					const content = await Bun.file(precondition.path).text()
					const currentRevision = documentRevision(content)
					if (currentRevision !== precondition.revision) {
						throw new RevisionConflictError({
							path: relative(root, precondition.path),
							expectedRevision: precondition.revision,
							currentRevision,
							message: `Revision conflict for ${relative(root, precondition.path)}`,
						})
					}
				}
				for (const write of staged) await Bun.write(write.stage, write.content)
				if (move) {
					await rename(move.from, move.to)
					moved = true
				}
				for (const write of staged) {
					await rename(write.path, write.backup)
					try {
						await rename(write.stage, write.path)
						installed.push(write)
					} catch (cause) {
						await rename(write.backup, write.path)
						throw cause
					}
				}
				await Promise.allSettled(
					installed.map((write) => rm(write.backup, { force: true })),
				)
			} catch (cause) {
				let rollbackCause: unknown
				for (const write of [...installed].reverse()) {
					try {
						await rm(write.path, { force: true })
						if (await exists(write.backup))
							await rename(write.backup, write.path)
					} catch (error) {
						rollbackCause ??= error
					}
				}
				if (moved && move) {
					try {
						await rename(move.to, move.from)
					} catch (error) {
						rollbackCause ??= error
					}
				}
				if (rollbackCause) {
					rollbackFailed = true
					throw new GraphMutationError({
						message: `Graph mutation rollback failed; recovery files with suffix '.${token}.backup' were preserved`,
						cause: new AggregateError([cause, rollbackCause]),
					})
				}
				throw cause
			} finally {
				await Promise.allSettled(
					staged.flatMap((write) => [
						rm(write.stage, { force: true }),
						...(rollbackFailed ? [] : [rm(write.backup, { force: true })]),
					]),
				)
				await lock.close().catch(() => undefined)
				await rm(lockPath, { force: true }).catch(() => undefined)
			}
		},
		catch: (cause) =>
			cause instanceof GraphMutationError ||
			cause instanceof RevisionConflictError
				? cause
				: new GraphMutationError({
						message:
							"Graph mutation failed; all staged changes were rolled back",
						cause,
					}),
	})

const contentWith = (
	record: { readonly content: string; readonly path: string },
	data: EpicData | TaskData | PhaseData,
) =>
	parseFrontmatter(record.content, record.path).pipe(
		Effect.map((parsed) => formatMarkdownDocument(data, parsed.body)),
	)

type RevisionedRecord = {
	readonly path: string
	readonly revision: string
}

const precondition = (
	record: RevisionedRecord,
	ifRevision?: string,
): { readonly path: string; readonly revision: string } => ({
	path: record.path,
	revision: ifRevision ?? record.revision,
})

const result = (
	root: string,
	operation: string,
	kind: MutationResult["entity"]["kind"],
	id: string,
	paths: readonly string[],
	previousId?: string,
): MutationResult => {
	const scope = paths.map((path) => relative(root, path))
	return {
		operation,
		changed: paths.length > 0 || previousId !== undefined,
		entity: { kind, id },
		...(previousId ? { previousId } : {}),
		changedPaths: scope,
		validation: {
			valid: true,
			scope,
			checks: ["schema", "references", "dependencies"],
		},
	}
}

const assertDependencies = (nodes: readonly Dependency[], label: string) => {
	const issue = validateDependencies(nodes, label)
	return issue
		? Effect.fail(new GraphMutationError({ message: issue }))
		: Effect.void
}

export class GraphMutationService extends Effect.Service<GraphMutationService>()(
	"GraphMutationService",
	{
		sync: () => ({
			updateEpic: (
				id: string,
				updates: EpicUpdates,
				startPath: string = process.cwd(),
				ifRevision?: string,
			) =>
				Effect.gen(function* () {
					const workbase = yield* WorkbaseService
					const epics = yield* EpicService
					const fs = yield* FileSystemService
					const root = yield* workbase.discover(startPath)
					const record = yield* epics.show(id, root)
					const data: EpicData = yield* decode(
						EpicFrontmatter,
						{
							...record.data,
							...(updates.description === null
								? { description: undefined }
								: updates.description !== undefined
									? { description: updates.description }
									: {}),
							...(updates.ticketUrl !== undefined
								? { ticketUrl: updates.ticketUrl }
								: {}),
							...(updates.repos !== undefined ? { repos: updates.repos } : {}),
						},
						"epic metadata",
					)
					for (const reference of data.repos) {
						if (!(yield* fs.exists(join(root, "repos", reference.repo)))) {
							return yield* new GraphMutationError({
								message: `Unknown repository alias '${reference.repo}'`,
							})
						}
					}
					if (
						new Set(data.repos.map((item) => item.repo)).size !==
						data.repos.length
					) {
						return yield* new GraphMutationError({
							message: "Repository references must be unique",
						})
					}
					const content = yield* contentWith(record, data)
					if (content === record.content) {
						if (ifRevision)
							yield* applyWritePlan({
								root,
								preconditions: [precondition(record, ifRevision)],
								writes: [],
							})
						return result(root, "epic.update", "epic", id, [])
					}
					yield* applyWritePlan({
						root,
						preconditions: [precondition(record, ifRevision)],
						writes: [{ path: record.path, content }],
					})
					return result(root, "epic.update", "epic", id, [record.path])
				}),

			updateTask: (
				id: string,
				updates: TaskUpdates,
				startPath: string = process.cwd(),
				ifRevision?: string,
			) =>
				Effect.gen(function* () {
					const workbase = yield* WorkbaseService
					const tasks = yield* TaskService
					const fs = yield* FileSystemService
					const root = yield* workbase.discover(startPath)
					const record = yield* tasks.show(id, root)
					const executionChange = [
						"repo",
						"repos",
						"branch",
						"base",
						"pr",
					].some((key) => updates[key as keyof TaskUpdates] !== undefined)
					if ("phases" in record.data && executionChange) {
						return yield* new GraphMutationError({
							message: `Task '${id}' has multiple phases; update execution metadata on a phase instead`,
						})
					}
					if (
						executionChange &&
						"claim" in record.data &&
						record.data.claim?.state === "active"
					) {
						return yield* new GraphMutationError({
							message: `Task '${id}' has an active claim; release or finish it before changing execution metadata`,
						})
					}
					if (
						executionChange &&
						(yield* fs.isDirectory(join(dirname(record.path), "code")))
					) {
						return yield* new GraphMutationError({
							message: `Task '${id}' has materialized code; remove its worktree with Agency before changing execution metadata`,
						})
					}
					const data: TaskData = yield* decode(
						TaskFrontmatter,
						{
							...record.data,
							...(updates.description === null
								? { description: undefined }
								: updates.description !== undefined
									? { description: updates.description }
									: {}),
							...(updates.ticketUrl !== undefined
								? { ticketUrl: updates.ticketUrl }
								: {}),
							...(updates.repo !== undefined ? { repo: updates.repo } : {}),
							...(updates.repos === null
								? { repos: undefined }
								: updates.repos !== undefined
									? { repos: updates.repos }
									: {}),
							...(updates.branch !== undefined
								? { branch: updates.branch }
								: {}),
							...(updates.base !== undefined ? { base: updates.base } : {}),
							...(updates.pr !== undefined ? { pr: updates.pr } : {}),
						},
						"task metadata",
					)
					if ("repo" in data) {
						const aliases = [
							data.repo,
							...(data.repos ?? []).map((item) => item.repo),
						]
						if (new Set(aliases).size !== aliases.length) {
							return yield* new GraphMutationError({
								message:
									"Repository references must be unique and cannot include the writable repository",
							})
						}
						for (const alias of aliases) {
							if (!(yield* fs.exists(join(root, "repos", alias)))) {
								return yield* new GraphMutationError({
									message: `Unknown repository alias '${alias}'`,
								})
							}
						}
						for (const other of yield* tasks.list(root)) {
							if (
								other.id !== id &&
								"repo" in other.data &&
								other.data.repo === data.repo &&
								other.data.branch === data.branch
							) {
								return yield* new GraphMutationError({
									message: `Writable branch '${data.branch}' for repository '${data.repo}' is already owned by task '${other.id}'`,
								})
							}
							if (!("phases" in other.data)) continue
							for (const phase of yield* (yield* PhaseService).list(
								other.id,
								root,
							)) {
								if (
									phase.data.repo === data.repo &&
									phase.data.branch === data.branch
								) {
									return yield* new GraphMutationError({
										message: `Writable branch '${data.branch}' for repository '${data.repo}' is already owned by phase '${other.id}/${phase.id}'`,
									})
								}
							}
						}
					}
					const content = yield* contentWith(record, data)
					if (content === record.content) {
						if (ifRevision)
							yield* applyWritePlan({
								root,
								preconditions: [precondition(record, ifRevision)],
								writes: [],
							})
						return result(root, "task.update", "task", id, [])
					}
					yield* applyWritePlan({
						root,
						preconditions: [precondition(record, ifRevision)],
						writes: [{ path: record.path, content }],
					})
					return result(root, "task.update", "task", id, [record.path])
				}),

			updatePhase: (
				taskId: string,
				id: string,
				updates: PhaseUpdates,
				startPath: string = process.cwd(),
				ifRevision?: string,
			) =>
				Effect.gen(function* () {
					const workbase = yield* WorkbaseService
					const phases = yield* PhaseService
					const fs = yield* FileSystemService
					const root = yield* workbase.discover(startPath)
					const record = yield* phases.show(taskId, id, root)
					const executionChange = [
						"repo",
						"repos",
						"branch",
						"base",
						"pr",
					].some((key) => updates[key as keyof PhaseUpdates] !== undefined)
					if (
						executionChange &&
						(yield* fs.isDirectory(join(dirname(record.path), "code")))
					) {
						return yield* new GraphMutationError({
							message: `Phase '${id}' has materialized code; remove its worktree with Agency before changing execution metadata`,
						})
					}
					if (executionChange && record.data.claim?.state === "active") {
						return yield* new GraphMutationError({
							message: `Phase '${id}' has an active claim; release or finish it before changing execution metadata`,
						})
					}
					const data: PhaseData = yield* decode(
						PhaseFrontmatter,
						{
							...record.data,
							...(updates.description === null
								? { description: undefined }
								: updates.description !== undefined
									? { description: updates.description }
									: {}),
							...(updates.repo !== undefined ? { repo: updates.repo } : {}),
							...(updates.repos === null
								? { repos: undefined }
								: updates.repos !== undefined
									? { repos: updates.repos }
									: {}),
							...(updates.branch !== undefined
								? { branch: updates.branch }
								: {}),
							...(updates.base !== undefined ? { base: updates.base } : {}),
							...(updates.pr !== undefined ? { pr: updates.pr } : {}),
						},
						"phase metadata",
					)
					const aliases = [
						data.repo,
						...(data.repos ?? []).map((item) => item.repo),
					]
					if (new Set(aliases).size !== aliases.length) {
						return yield* new GraphMutationError({
							message:
								"Repository references must be unique and cannot include the writable repository",
						})
					}
					for (const alias of aliases) {
						if (!(yield* fs.exists(join(root, "repos", alias)))) {
							return yield* new GraphMutationError({
								message: `Unknown repository alias '${alias}'`,
							})
						}
					}
					for (const task of yield* (yield* TaskService).list(root)) {
						if (
							"repo" in task.data &&
							task.data.repo === data.repo &&
							task.data.branch === data.branch
						) {
							return yield* new GraphMutationError({
								message: `Writable branch '${data.branch}' for repository '${data.repo}' is already owned by task '${task.id}'`,
							})
						}
						if (!("phases" in task.data)) continue
						for (const other of yield* phases.list(task.id, root)) {
							if (
								(task.id !== taskId || other.id !== id) &&
								other.data.repo === data.repo &&
								other.data.branch === data.branch
							) {
								return yield* new GraphMutationError({
									message: `Writable branch '${data.branch}' for repository '${data.repo}' is already owned by phase '${task.id}/${other.id}'`,
								})
							}
						}
					}
					const content = yield* contentWith(record, data)
					if (content === record.content) {
						if (ifRevision)
							yield* applyWritePlan({
								root,
								preconditions: [precondition(record, ifRevision)],
								writes: [],
							})
						return result(root, "phase.update", "phase", id, [])
					}
					yield* applyWritePlan({
						root,
						preconditions: [precondition(record, ifRevision)],
						writes: [{ path: record.path, content }],
					})
					return result(root, "phase.update", "phase", id, [record.path])
				}),

			mutateTaskDependency: (
				operation: "add" | "remove",
				id: string,
				dependencyId: string,
				startPath: string = process.cwd(),
				ifRevision?: string,
			) =>
				Effect.gen(function* () {
					const workbase = yield* WorkbaseService
					const tasks = yield* TaskService
					const epics = yield* EpicService
					const root = yield* workbase.discover(startPath)
					const task = yield* tasks.show(id, root)
					if (!task.data.epic)
						return yield* new GraphMutationError({
							message: `Task '${id}' has no parent epic; task dependencies are scoped to an epic`,
						})
					const epic = yield* epics.show(task.data.epic, root)
					const declaration = epic.data.tasks.find((item) => item.id === id)
					if (!declaration)
						return yield* new GraphMutationError({
							message: `Epic '${epic.id}' does not list task '${id}'; run agency validate for repair details`,
						})
					if (operation === "add") {
						const dependency = yield* tasks.show(dependencyId, root)
						if (dependency.data.epic !== epic.id) {
							return yield* new GraphMutationError({
								message: `Task dependency '${dependencyId}' does not belong to epic '${epic.id}'`,
							})
						}
					}
					const current = declaration.dependsOn ?? []
					if (operation === "add" && current.includes(dependencyId))
						return yield* new GraphMutationError({
							message: `Task '${id}' already depends on '${dependencyId}'`,
						})
					if (operation === "remove" && !current.includes(dependencyId))
						return yield* new GraphMutationError({
							message: `Task '${id}' does not depend on '${dependencyId}'`,
						})
					const dependencies =
						operation === "add"
							? [...current, dependencyId]
							: current.filter((item) => item !== dependencyId)
					const data = {
						...epic.data,
						tasks: epic.data.tasks.map((item) =>
							item.id === id
								? {
										id: item.id,
										...(dependencies.length ? { dependsOn: dependencies } : {}),
									}
								: item,
						),
					}
					yield* assertDependencies(data.tasks, "Tasks")
					const content = yield* contentWith(epic, data)
					yield* applyWritePlan({
						root,
						preconditions: [precondition(task, ifRevision), precondition(epic)],
						writes: [{ path: epic.path, content }],
					})
					return result(root, `task.dependency.${operation}`, "task", id, [
						epic.path,
					])
				}),

			mutatePhaseDependency: (
				operation: "add" | "remove",
				taskId: string,
				id: string,
				dependencyId: string,
				startPath: string = process.cwd(),
				ifRevision?: string,
			) =>
				Effect.gen(function* () {
					const workbase = yield* WorkbaseService
					const tasks = yield* TaskService
					const root = yield* workbase.discover(startPath)
					const task = yield* tasks.show(taskId, root)
					const phase = yield* (yield* PhaseService).show(taskId, id, root)
					if (!("phases" in task.data))
						return yield* new GraphMutationError({
							message: `Task '${taskId}' does not have phases`,
						})
					const declaration = task.data.phases.find((item) => item.id === id)
					if (!declaration)
						return yield* new GraphMutationError({
							message: `Phase '${id}' does not exist on task '${taskId}'`,
						})
					if (operation === "add") {
						yield* (yield* PhaseService).show(taskId, dependencyId, root)
					}
					const current = declaration.dependsOn ?? []
					if (operation === "add" && current.includes(dependencyId))
						return yield* new GraphMutationError({
							message: `Phase '${id}' already depends on '${dependencyId}'`,
						})
					if (operation === "remove" && !current.includes(dependencyId))
						return yield* new GraphMutationError({
							message: `Phase '${id}' does not depend on '${dependencyId}'`,
						})
					const dependencies =
						operation === "add"
							? [...current, dependencyId]
							: current.filter((item) => item !== dependencyId)
					const data = {
						...task.data,
						phases: task.data.phases.map((item) =>
							item.id === id
								? {
										id: item.id,
										...(dependencies.length ? { dependsOn: dependencies } : {}),
									}
								: item,
						),
					}
					yield* assertDependencies(data.phases, "Phases")
					const content = yield* contentWith(task, data)
					yield* applyWritePlan({
						root,
						preconditions: [
							precondition(phase, ifRevision),
							precondition(task),
						],
						writes: [{ path: task.path, content }],
					})
					return result(root, `phase.dependency.${operation}`, "phase", id, [
						task.path,
					])
				}),

			renameEpic: (
				id: string,
				newId: string,
				startPath: string = process.cwd(),
				ifRevision?: string,
			) =>
				Effect.gen(function* () {
					const workbase = yield* WorkbaseService
					const epics = yield* EpicService
					const tasks = yield* TaskService
					const fs = yield* FileSystemService
					const root = yield* workbase.discover(startPath)
					yield* decodeId(newId, "epic")
					const epic = yield* epics.show(id, root)
					const from = dirname(epic.path)
					const to = join(root, "epics", newId)
					if (yield* fs.exists(to))
						return yield* new GraphMutationError({
							message: `Epic '${newId}' already exists`,
						})
					const allTasks = yield* tasks.list(root)
					const declared = new Set(epic.data.tasks.map((item) => item.id))
					for (const declaration of epic.data.tasks) {
						const child = allTasks.find((item) => item.id === declaration.id)
						if (!child || child.data.epic !== id) {
							return yield* new GraphMutationError({
								message: `Cannot rename epic '${id}': task '${declaration.id}' does not have a matching parent backlink; run agency validate for details`,
							})
						}
					}
					const unlisted = allTasks.find(
						(item) => item.data.epic === id && !declared.has(item.id),
					)
					if (unlisted) {
						return yield* new GraphMutationError({
							message: `Cannot rename epic '${id}': task '${unlisted.id}' is not listed by the epic; run agency validate for details`,
						})
					}
					const writes: { path: string; content: string }[] = []
					for (const task of allTasks) {
						if (task.data.epic !== id) continue
						const data = yield* decode(
							TaskFrontmatter,
							{ ...task.data, epic: newId },
							"task metadata",
						)
						writes.push({
							path: task.path,
							content: yield* contentWith(task, data),
						})
					}
					yield* applyWritePlan({
						root,
						preconditions: [
							precondition(epic, ifRevision),
							...allTasks
								.filter((task) => task.data.epic === id)
								.map((task) => precondition(task)),
						],
						writes,
						move: { from, to },
					})
					return result(
						root,
						"epic.rename",
						"epic",
						newId,
						[join(to, "EPIC.md"), ...writes.map((write) => write.path)],
						id,
					)
				}),

			renameTask: (
				id: string,
				newId: string,
				startPath: string = process.cwd(),
				ifRevision?: string,
			) =>
				Effect.gen(function* () {
					const workbase = yield* WorkbaseService
					const epics = yield* EpicService
					const tasks = yield* TaskService
					const fs = yield* FileSystemService
					const root = yield* workbase.discover(startPath)
					yield* decodeId(newId, "task")
					const task = yield* tasks.show(id, root)
					const from = dirname(task.path)
					const to = join(root, "tasks", newId)
					if (yield* fs.exists(to))
						return yield* new GraphMutationError({
							message: `Task '${newId}' already exists`,
						})
					if ("claim" in task.data && task.data.claim?.state === "active")
						return yield* new GraphMutationError({
							message: `Task '${id}' has an active claim; release or finish it before renaming`,
						})
					if (yield* fs.isDirectory(join(from, "code")))
						return yield* new GraphMutationError({
							message: `Task '${id}' has a materialized worktree; remove it with Agency before renaming`,
						})
					const movedPhases: PhaseRecord[] = []
					if ("phases" in task.data) {
						for (const phase of task.data.phases) {
							const record = yield* (yield* PhaseService).show(
								id,
								phase.id,
								root,
							)
							movedPhases.push(record)
							if (record.data.claim?.state === "active")
								return yield* new GraphMutationError({
									message: `Phase '${phase.id}' has an active claim; release or finish it before renaming task '${id}'`,
								})
							if (yield* fs.isDirectory(join(dirname(record.path), "code")))
								return yield* new GraphMutationError({
									message: `Phase '${phase.id}' has a materialized worktree; remove it with Agency before renaming task '${id}'`,
								})
						}
					}
					if (task.data.epic) {
						const parent = yield* epics.show(task.data.epic, root)
						if (!parent.data.tasks.some((item) => item.id === id)) {
							return yield* new GraphMutationError({
								message: `Cannot rename task '${id}': parent epic '${parent.id}' does not list it; run agency validate for details`,
							})
						}
					}
					const writes: { path: string; content: string }[] = []
					const affectedEpics: EpicRecord[] = []
					for (const epic of yield* epics.list(root)) {
						if (
							!epic.data.tasks.some(
								(item) => item.id === id || item.dependsOn?.includes(id),
							)
						)
							continue
						affectedEpics.push(epic)
						const data = {
							...epic.data,
							tasks: epic.data.tasks.map((item) => ({
								...item,
								id: item.id === id ? newId : item.id,
								...(item.dependsOn
									? {
											dependsOn: item.dependsOn.map((dependency) =>
												dependency === id ? newId : dependency,
											),
										}
									: {}),
							})),
						}
						yield* assertDependencies(data.tasks, "Tasks")
						writes.push({
							path: epic.path,
							content: yield* contentWith(epic, data),
						})
					}
					yield* applyWritePlan({
						root,
						preconditions: [
							precondition(task, ifRevision),
							...movedPhases.map((phase) => precondition(phase)),
							...affectedEpics.map((epic) => precondition(epic)),
						],
						writes,
						move: { from, to },
					})
					return result(
						root,
						"task.rename",
						"task",
						newId,
						[join(to, "TASK.md"), ...writes.map((write) => write.path)],
						id,
					)
				}),

			renamePhase: (
				taskId: string,
				id: string,
				newId: string,
				startPath: string = process.cwd(),
				ifRevision?: string,
			) =>
				Effect.gen(function* () {
					const workbase = yield* WorkbaseService
					const tasks = yield* TaskService
					const phases = yield* PhaseService
					const fs = yield* FileSystemService
					const root = yield* workbase.discover(startPath)
					yield* decodeId(newId, "phase")
					const task = yield* tasks.show(taskId, root)
					if (!("phases" in task.data))
						return yield* new GraphMutationError({
							message: `Task '${taskId}' does not have phases`,
						})
					if (!task.data.phases.some((item) => item.id === id)) {
						return yield* new GraphMutationError({
							message: `Cannot rename phase '${id}': task '${taskId}' does not list it; run agency validate for details`,
						})
					}
					const phase = yield* phases.show(taskId, id, root)
					if (phase.data.claim?.state === "active")
						return yield* new GraphMutationError({
							message: `Phase '${id}' has an active claim; release or finish it before renaming`,
						})
					const from = dirname(phase.path)
					const to = join(dirname(from), newId)
					if (yield* fs.exists(to))
						return yield* new GraphMutationError({
							message: `Phase '${newId}' already exists on task '${taskId}'`,
						})
					if (yield* fs.isDirectory(join(from, "code")))
						return yield* new GraphMutationError({
							message: `Phase '${id}' has a materialized worktree; remove it with Agency before renaming`,
						})
					const data = {
						...task.data,
						phases: task.data.phases.map((item) => ({
							...item,
							id: item.id === id ? newId : item.id,
							...(item.dependsOn
								? {
										dependsOn: item.dependsOn.map((dependency) =>
											dependency === id ? newId : dependency,
										),
									}
								: {}),
						})),
					}
					yield* assertDependencies(data.phases, "Phases")
					const content = yield* contentWith(task, data)
					yield* applyWritePlan({
						root,
						preconditions: [
							precondition(phase, ifRevision),
							precondition(task),
						],
						writes: [{ path: task.path, content }],
						move: { from, to },
					})
					return result(
						root,
						"phase.rename",
						"phase",
						newId,
						[join(to, "PHASE.md"), task.path],
						id,
					)
				}),

			moveTask: (
				id: string,
				epicId: string | null,
				startPath: string = process.cwd(),
				ifRevision?: string,
			) =>
				Effect.gen(function* () {
					const workbase = yield* WorkbaseService
					const tasks = yield* TaskService
					const epics = yield* EpicService
					const root = yield* workbase.discover(startPath)
					const task = yield* tasks.show(id, root)
					const sourceId = task.data.epic
					if (sourceId === epicId) {
						if (ifRevision)
							yield* applyWritePlan({
								root,
								preconditions: [precondition(task, ifRevision)],
								writes: [],
							})
						return result(root, "task.move", "task", id, [])
					}
					const source = sourceId
						? yield* epics.show(sourceId, root)
						: undefined
					const target = epicId ? yield* epics.show(epicId, root) : undefined
					const declaration = source?.data.tasks.find((item) => item.id === id)
					if (source && !declaration)
						return yield* new GraphMutationError({
							message: `Epic '${source.id}' does not list task '${id}'; run agency validate for repair details`,
						})
					const dependent = source?.data.tasks.find((item) =>
						item.dependsOn?.includes(id),
					)
					if ((declaration?.dependsOn?.length ?? 0) > 0 || dependent) {
						return yield* new GraphMutationError({
							message: `Cannot move task '${id}' while scoped dependencies exist; remove ${dependent ? `dependency from '${dependent.id}'` : `its dependencies (${declaration!.dependsOn!.join(", ")})`} first`,
						})
					}
					if (target?.data.tasks.some((item) => item.id === id))
						return yield* new GraphMutationError({
							message: `Epic '${target.id}' already lists task '${id}'`,
						})
					const writes: { path: string; content: string }[] = []
					if (source) {
						const data = {
							...source.data,
							tasks: source.data.tasks.filter((item) => item.id !== id),
						}
						yield* assertDependencies(data.tasks, "Tasks")
						writes.push({
							path: source.path,
							content: yield* contentWith(source, data),
						})
					}
					if (target) {
						const data = {
							...target.data,
							tasks: [...target.data.tasks, { id }],
						}
						yield* assertDependencies(data.tasks, "Tasks")
						writes.push({
							path: target.path,
							content: yield* contentWith(target, data),
						})
					}
					const taskData = yield* decode(
						TaskFrontmatter,
						epicId
							? { ...task.data, epic: epicId }
							: { ...task.data, epic: undefined },
						"task metadata",
					)
					writes.push({
						path: task.path,
						content: yield* contentWith(task, taskData),
					})
					yield* applyWritePlan({
						root,
						preconditions: [
							precondition(task, ifRevision),
							...(source ? [precondition(source)] : []),
							...(target ? [precondition(target)] : []),
						],
						writes,
					})
					return result(
						root,
						"task.move",
						"task",
						id,
						writes.map((write) => write.path),
					)
				}),
		}),
	},
) {}
