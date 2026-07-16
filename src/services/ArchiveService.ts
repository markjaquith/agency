import { Data, Effect } from "effect"
import { dirname, join } from "node:path"
import { EpicService, type EpicRecord } from "./EpicService"
import { FileSystemService } from "./FileSystemService"
import { PhaseService } from "./PhaseService"
import { TaskService } from "./TaskService"
import { WorkbaseService } from "./WorkbaseService"
import { WorktreeService } from "./WorktreeService"
import {
	formatMarkdownDocument,
	parseFrontmatter,
} from "../workbase/frontmatter"
import type { TaskFrontmatter as TaskData } from "../workbase/schemas"

class ArchiveError extends Data.TaggedError("ArchiveError")<{
	readonly message: string
}> {}

interface ArchiveResult {
	readonly kind: "epic" | "task" | "phase"
	readonly id: string
	readonly taskId?: string
	readonly path: string
	readonly archivedPaths: readonly string[]
	readonly removedWorktrees: readonly string[]
}

interface TaskRecord {
	readonly id: string
	readonly path: string
	readonly content: string
	readonly data: TaskData
}

const rejectExistingDestination = (path: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystemService
		if (yield* fs.exists(path)) {
			return yield* new ArchiveError({
				message: `Archive destination already exists: ${path}`,
			})
		}
	})

export class ArchiveService extends Effect.Service<ArchiveService>()(
	"ArchiveService",
	{
		sync: () => ({
			archiveEpic: (id: string, startPath: string = process.cwd()) =>
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

					const epicDestination = join(root, "archive", "epics", id)
					yield* rejectExistingDestination(epicDestination)
					for (const task of taskRecords) {
						yield* rejectExistingDestination(
							join(root, "archive", "tasks", task.id),
						)
					}

					const removedWorktrees: string[] = []
					for (const task of taskRecords) {
						if ("phases" in task.data) {
							for (const phase of task.data.phases) {
								removedWorktrees.push(
									...(yield* worktrees.remove(task.id, phase.id, root)),
								)
							}
						} else {
							removedWorktrees.push(
								...(yield* worktrees.remove(task.id, undefined, root)),
							)
						}
					}

					const archivedPaths: string[] = []
					for (const task of taskRecords) {
						const destination = join(root, "archive", "tasks", task.id)
						yield* fs.createDirectory(dirname(destination))
						yield* fs.moveDirectory(dirname(task.path), destination)
						archivedPaths.push(destination)
					}
					yield* fs.createDirectory(dirname(epicDestination))
					yield* fs.moveDirectory(dirname(epic.path), epicDestination)
					archivedPaths.push(epicDestination)

					return {
						kind: "epic",
						id,
						path: epicDestination,
						archivedPaths,
						removedWorktrees,
					} satisfies ArchiveResult
				}),

			archiveTask: (id: string, startPath: string = process.cwd()) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const workbase = yield* WorkbaseService
					const epics = yield* EpicService
					const tasks = yield* TaskService
					const worktrees = yield* WorktreeService
					const root = yield* workbase.discover(startPath)
					const task = yield* tasks.show(id, root)
					const destination = join(root, "archive", "tasks", id)
					yield* rejectExistingDestination(destination)

					let parentEpic: EpicRecord | undefined
					if (task.data.epic) {
						parentEpic = yield* epics.show(task.data.epic, root)
						const dependent = parentEpic.data.tasks.find((child) =>
							child.dependsOn?.includes(id),
						)
						if (dependent) {
							return yield* new ArchiveError({
								message: `Cannot archive task '${id}'; task '${dependent.id}' depends on it`,
							})
						}
					}

					const removedWorktrees: string[] = []
					if ("phases" in task.data) {
						for (const phase of task.data.phases) {
							removedWorktrees.push(
								...(yield* worktrees.remove(id, phase.id, root)),
							)
						}
					} else {
						removedWorktrees.push(
							...(yield* worktrees.remove(id, undefined, root)),
						)
					}

					if (parentEpic) {
						const parsed = yield* parseFrontmatter(
							parentEpic.content,
							parentEpic.path,
						)
						yield* fs.writeFile(
							parentEpic.path,
							formatMarkdownDocument(
								{
									...parentEpic.data,
									tasks: parentEpic.data.tasks.filter(
										(child) => child.id !== id,
									),
								},
								parsed.body,
							),
						)
					}

					yield* fs.createDirectory(dirname(destination))
					yield* fs.moveDirectory(dirname(task.path), destination)
					return {
						kind: "task",
						id,
						path: destination,
						archivedPaths: [destination],
						removedWorktrees,
					} satisfies ArchiveResult
				}),

			archivePhase: (
				taskId: string,
				id: string,
				startPath: string = process.cwd(),
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
					const dependent = task.data.phases.find((candidate) =>
						candidate.dependsOn?.includes(id),
					)
					if (dependent) {
						return yield* new ArchiveError({
							message: `Cannot archive phase '${id}'; phase '${dependent.id}' depends on it`,
						})
					}

					const destination = join(
						root,
						"archive",
						"tasks",
						taskId,
						"phases",
						id,
					)
					yield* rejectExistingDestination(destination)
					const removedWorktrees = yield* worktrees.remove(taskId, id, root)

					const parsed = yield* parseFrontmatter(task.content, task.path)
					yield* fs.writeFile(
						task.path,
						formatMarkdownDocument(
							{
								...task.data,
								phases: task.data.phases.filter(
									(candidate) => candidate.id !== id,
								),
							},
							parsed.body,
						),
					)
					yield* fs.createDirectory(dirname(destination))
					yield* fs.moveDirectory(dirname(phase.path), destination)

					return {
						kind: "phase",
						id,
						taskId,
						path: destination,
						archivedPaths: [destination],
						removedWorktrees,
					} satisfies ArchiveResult
				}),
		}),
	},
) {}
