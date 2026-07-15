import { Schema, TreeFormatter } from "@effect/schema"
import { Data, Effect, Either } from "effect"
import { join } from "node:path"
import { FileSystemService } from "./FileSystemService"
import { WorkbaseService } from "./WorkbaseService"
import { TaskService } from "./TaskService"
import {
	EntityId,
	PhaseFrontmatter,
	type PhaseFrontmatter as PhaseData,
} from "../workbase/schemas"
import {
	formatMarkdownDocument,
	parseFrontmatter,
} from "../workbase/frontmatter"

class PhaseError extends Data.TaggedError("PhaseError")<{
	readonly message: string
}> {}

export interface PhaseRecord {
	readonly taskId: string
	readonly id: string
	readonly path: string
	readonly content: string
	readonly data: PhaseData
}

export interface CreatePhaseInput {
	readonly taskId: string
	readonly id: string
	readonly description?: string
	readonly repo: string
	readonly repos?: readonly string[]
	readonly branch: string
	readonly base: string
	readonly dependsOn?: readonly string[]
}

const decodeId = (id: string, label: string) => {
	const result = Schema.decodeUnknownEither(EntityId)(id)
	return Either.isLeft(result)
		? Effect.fail(new PhaseError({ message: `Invalid ${label} ID '${id}'` }))
		: Effect.succeed(result.right)
}

const decodePhase = (input: unknown) => {
	const result = Schema.decodeUnknownEither(PhaseFrontmatter, {
		errors: "all",
		onExcessProperty: "error",
	})(input)
	return Either.isLeft(result)
		? Effect.fail(
				new PhaseError({ message: TreeFormatter.formatErrorSync(result.left) }),
			)
		: Effect.succeed(result.right)
}

export class PhaseService extends Effect.Service<PhaseService>()(
	"PhaseService",
	{
		sync: () => ({
			create: (input: CreatePhaseInput, startPath: string = process.cwd()) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const workbase = yield* WorkbaseService
					const tasks = yield* TaskService
					const root = yield* workbase.discover(startPath)
					const taskId = yield* decodeId(input.taskId, "task")
					const id = yield* decodeId(input.id, "phase")
					const task = yield* tasks.show(taskId, root)
					if (!("phases" in task.data)) {
						return yield* new PhaseError({
							message:
								"Cannot add a phase to a single-phase task; conversion is not implemented",
						})
					}
					if (task.data.phases.some((phase) => phase.id === id)) {
						return yield* new PhaseError({
							message: `Phase '${id}' already exists on task '${taskId}'`,
						})
					}
					const knownPhases = new Set(task.data.phases.map((phase) => phase.id))
					for (const dependency of input.dependsOn ?? []) {
						if (!knownPhases.has(dependency)) {
							return yield* new PhaseError({
								message: `Unknown phase dependency '${dependency}'`,
							})
						}
					}

					const data = yield* decodePhase({
						...(input.description !== undefined
							? { description: input.description }
							: {}),
						repo: input.repo,
						...(input.repos?.length ? { repos: input.repos } : {}),
						branch: input.branch,
						base: input.base,
						pr: null,
					})
					for (const alias of [data.repo, ...(data.repos ?? [])]) {
						if (!(yield* fs.exists(join(root, "repos", alias)))) {
							return yield* new PhaseError({
								message: `Unknown repository alias '${alias}'`,
							})
						}
					}

					const directory = join(root, "tasks", taskId, "phases", id)
					const path = join(directory, "PHASE.md")
					if (yield* fs.exists(directory)) {
						return yield* new PhaseError({
							message: `Phase directory already exists: ${id}`,
						})
					}
					const title = id
						.split("-")
						.map((part) => part[0]?.toUpperCase() + part.slice(1))
						.join(" ")
					const content = formatMarkdownDocument(
						data,
						`# ${title}\n\nDescribe the phase outcome.`,
					)
					yield* fs.createDirectory(directory)
					yield* fs.writeFile(path, content)

					const parsedTask = yield* parseFrontmatter(task.content, task.path)
					const updatedTaskData = {
						...task.data,
						phases: [
							...task.data.phases,
							{
								id,
								...(input.dependsOn?.length
									? { dependsOn: input.dependsOn }
									: {}),
							},
						],
					}
					yield* fs.writeFile(
						task.path,
						formatMarkdownDocument(updatedTaskData, parsedTask.body),
					)

					return { taskId, id, path, content, data } satisfies PhaseRecord
				}),

			list: (taskId: string, startPath: string = process.cwd()) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const workbase = yield* WorkbaseService
					const tasks = yield* TaskService
					const root = yield* workbase.discover(startPath)
					const validTaskId = yield* decodeId(taskId, "task")
					yield* tasks.show(validTaskId, root)
					const directory = join(root, "tasks", validTaskId, "phases")
					if (!(yield* fs.isDirectory(directory))) return [] as PhaseRecord[]
					const entries = (yield* fs.readDirectory(directory))
						.filter((entry) => entry.isDirectory)
						.sort((a, b) => a.name.localeCompare(b.name))
					const records: PhaseRecord[] = []
					for (const entry of entries) {
						const path = join(directory, entry.name, "PHASE.md")
						if (!(yield* fs.exists(path))) continue
						const content = yield* fs.readFile(path)
						const parsed = yield* parseFrontmatter(content, path)
						const data = yield* decodePhase(parsed.data)
						records.push({
							taskId: validTaskId,
							id: entry.name,
							path,
							content,
							data,
						})
					}
					return records
				}),

			show: (taskId: string, id: string, startPath: string = process.cwd()) =>
				Effect.gen(function* () {
					const service = yield* PhaseService
					const validId = yield* decodeId(id, "phase")
					const record = (yield* service.list(taskId, startPath)).find(
						(phase) => phase.id === validId,
					)
					if (!record) {
						return yield* new PhaseError({
							message: `Phase '${validId}' does not exist on task '${taskId}'`,
						})
					}
					return record
				}),
		}),
	},
) {}
