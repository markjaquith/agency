import { Schema, TreeFormatter } from "@effect/schema"
import { Data, Effect, Either } from "effect"
import { join } from "node:path"
import { FileSystemService } from "./FileSystemService"
import { WorkbaseService } from "./WorkbaseService"
import { EpicService, type EpicRecord } from "./EpicService"
import {
	EntityId,
	TaskFrontmatter,
	type RepositoryReference,
	type TaskFrontmatter as TaskData,
	WorkStatus,
} from "../workbase/schemas"
import {
	formatMarkdownDocument,
	parseFrontmatter,
} from "../workbase/frontmatter"
import { canTransitionStatus } from "../readiness"
import { documentRevision } from "../workbase/document-revision"
import { archivedTaskDirectory } from "../workbase/archive"
import {
	documentWriteStep,
	runLifecycleTransaction,
} from "./LifecycleTransaction"

class TaskError extends Data.TaggedError("TaskError")<{
	readonly message: string
}> {}

interface TaskRecord {
	readonly id: string
	readonly path: string
	readonly content: string
	readonly revision: string
	readonly data: TaskData
}

export interface CreateTaskInput {
	readonly id: string
	readonly ticketUrl: string | null
	readonly description?: string
	readonly epic?: string
	readonly multiPhase?: boolean
	readonly repo?: string
	readonly repos?: readonly RepositoryReference[]
	readonly branch?: string
	readonly base?: string
}

const decodeTask = (input: unknown) => {
	const result = Schema.decodeUnknownEither(TaskFrontmatter, {
		errors: "all",
		onExcessProperty: "error",
	})(input)
	return Either.isLeft(result)
		? Effect.fail(
				new TaskError({ message: TreeFormatter.formatErrorSync(result.left) }),
			)
		: Effect.succeed(result.right)
}

const decodeId = (id: string) => {
	const result = Schema.decodeUnknownEither(EntityId)(id)
	return Either.isLeft(result)
		? Effect.fail(new TaskError({ message: `Invalid task ID '${id}'` }))
		: Effect.succeed(result.right)
}

const decodeStatus = (status: string) => {
	const result = Schema.decodeUnknownEither(WorkStatus)(status)
	return Either.isLeft(result)
		? Effect.fail(new TaskError({ message: `Invalid work status '${status}'` }))
		: Effect.succeed(result.right)
}

export class TaskService extends Effect.Service<TaskService>()("TaskService", {
	sync: () => ({
		create: (input: CreateTaskInput, startPath: string = process.cwd()) =>
			Effect.gen(function* () {
				const fs = yield* FileSystemService
				const workbase = yield* WorkbaseService
				const epics = yield* EpicService
				const root = yield* workbase.discover(startPath)
				const id = yield* decodeId(input.id)
				const directory = join(root, "tasks", id)
				const path = join(directory, "TASK.md")

				if (yield* fs.exists(directory)) {
					return yield* new TaskError({
						message: `Task '${id}' already exists`,
					})
				}
				if (yield* fs.exists(archivedTaskDirectory(root, id))) {
					return yield* new TaskError({
						message: `Task '${id}' is archived; restore it before reusing this ID`,
					})
				}

				let data: TaskData
				if (input.multiPhase) {
					data = yield* decodeTask({
						ticketUrl: input.ticketUrl,
						...(input.description !== undefined
							? { description: input.description }
							: {}),
						...(input.epic ? { epic: input.epic } : {}),
						phases: [],
					})
				} else {
					if (!input.repo || !input.branch || !input.base) {
						return yield* new TaskError({
							message: "Single-phase tasks require repo, branch, and base",
						})
					}
					data = yield* decodeTask({
						ticketUrl: input.ticketUrl,
						...(input.description !== undefined
							? { description: input.description }
							: {}),
						...(input.epic ? { epic: input.epic } : {}),
						repo: input.repo,
						...(input.repos?.length ? { repos: input.repos } : {}),
						branch: input.branch,
						base: input.base,
						pr: null,
					})
				}

				const referencedRepos =
					"repo" in data
						? [
								data.repo,
								...(data.repos ?? []).map((reference) => reference.repo),
							]
						: []
				if (new Set(referencedRepos).size !== referencedRepos.length) {
					return yield* new TaskError({
						message:
							"Repository references must be unique and cannot include the writable repository",
					})
				}
				for (const alias of referencedRepos) {
					if (!(yield* fs.exists(join(root, "repos", alias)))) {
						return yield* new TaskError({
							message: `Unknown repository alias '${alias}'`,
						})
					}
				}

				let parentEpic: EpicRecord | undefined
				if (input.epic) {
					parentEpic = yield* epics.show(input.epic, root)
					if (parentEpic.data.tasks.some((task) => task.id === id)) {
						return yield* new TaskError({
							message: `Epic '${input.epic}' already lists task '${id}'`,
						})
					}
				}

				const title = id
					.split("-")
					.map((part) => part[0]?.toUpperCase() + part.slice(1))
					.join(" ")
				const content = formatMarkdownDocument(
					data,
					`# ${title}\n\nDescribe the task outcome.`,
				)
				const writes: {
					path: string
					content: string
					create?: boolean
				}[] = [{ path, content, create: true }]
				if (input.epic && parentEpic) {
					const parsed = yield* parseFrontmatter(
						parentEpic.content,
						parentEpic.path,
					)
					const epicData = {
						...parentEpic.data,
						tasks: [...parentEpic.data.tasks, { id }],
					}
					const updated = formatMarkdownDocument(epicData, parsed.body)
					writes.push({ path: parentEpic.path, content: updated })
				}
				yield* runLifecycleTransaction({
					root,
					preconditions: parentEpic
						? [{ path: parentEpic.path, revision: parentEpic.revision }]
						: [],
					steps: [documentWriteStep(root, writes)],
				})

				return {
					id,
					path,
					content,
					revision: documentRevision(content),
					data,
				} satisfies TaskRecord
			}),

		list: (startPath: string = process.cwd()) =>
			Effect.gen(function* () {
				const fs = yield* FileSystemService
				const workbase = yield* WorkbaseService
				const root = yield* workbase.discover(startPath)
				const directory = join(root, "tasks")
				if (!(yield* fs.isDirectory(directory))) return [] as TaskRecord[]
				const entries = (yield* fs.readDirectory(directory))
					.filter((entry) => entry.isDirectory)
					.sort((a, b) => a.name.localeCompare(b.name))
				const records: TaskRecord[] = []
				for (const entry of entries) {
					const path = join(directory, entry.name, "TASK.md")
					if (!(yield* fs.exists(path))) continue
					const content = yield* fs.readFile(path)
					const parsed = yield* parseFrontmatter(content, path)
					const data = yield* decodeTask(parsed.data)
					records.push({
						id: entry.name,
						path,
						content,
						revision: documentRevision(content),
						data,
					})
				}
				return records
			}),

		show: (id: string, startPath: string = process.cwd()) =>
			Effect.gen(function* () {
				const service = yield* TaskService
				const validId = yield* decodeId(id)
				const record = (yield* service.list(startPath)).find(
					(task) => task.id === validId,
				)
				if (!record) {
					return yield* new TaskError({
						message: `Task '${validId}' does not exist`,
					})
				}
				return record
			}),

		setStatus: (
			id: string,
			status: string,
			startPath: string = process.cwd(),
		) =>
			Effect.gen(function* () {
				const fs = yield* FileSystemService
				const service = yield* TaskService
				const validStatus = yield* decodeStatus(status)
				if (validStatus === "working" || validStatus === "delegated") {
					return yield* new TaskError({
						message:
							"Active work and delegation require explicit ownership; use 'agency claim'",
					})
				}
				const record = yield* service.show(id, startPath)
				if ("phases" in record.data) {
					return yield* new TaskError({
						message: `Task '${id}' has multiple phases; set status on a phase instead`,
					})
				}
				if (record.data.claim?.state === "active") {
					return yield* new TaskError({
						message: `Task '${id}' has an active claim; use agency release or agency finish`,
					})
				}
				if (!canTransitionStatus(record.data.status, validStatus)) {
					return yield* new TaskError({
						message: `Cannot transition task '${id}' from ${record.data.status} to ${validStatus}; reopen it first`,
					})
				}
				const parsed = yield* parseFrontmatter(record.content, record.path)
				const data = { ...record.data, status: validStatus }
				const content = formatMarkdownDocument(data, parsed.body)
				yield* fs.writeFile(record.path, content)
				return {
					...record,
					content,
					revision: documentRevision(content),
					data,
				} satisfies TaskRecord
			}),
	}),
}) {}
