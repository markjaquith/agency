import { Schema } from "@effect/schema"
import { TreeFormatter } from "@effect/schema"
import { Data, Effect, Either } from "effect"
import { dirname, join, relative, resolve } from "node:path"
import { FileSystemService } from "./FileSystemService"
import { parseFrontmatter } from "../workbase/frontmatter"
import {
	EpicFrontmatter,
	PhaseFrontmatter,
	TaskFrontmatter,
	WorkbaseConfig,
	type Dependency,
	type EpicFrontmatter as EpicData,
	type PhaseFrontmatter as PhaseData,
	type TaskFrontmatter as TaskData,
} from "../workbase/schemas"
import { validateWorktreeCreateCommand } from "../workbase/worktree-command"

class WorkbaseNotFoundError extends Data.TaggedError("WorkbaseNotFoundError")<{
	readonly message: string
}> {}

class WorkbaseConfigError extends Data.TaggedError("WorkbaseConfigError")<{
	readonly message: string
	readonly path: string
	readonly cause?: unknown
}> {}

interface ValidationIssue {
	readonly path: string
	readonly message: string
}

interface ValidationReport {
	readonly root: string
	readonly issues: readonly ValidationIssue[]
	readonly epicCount: number
	readonly taskCount: number
	readonly phaseCount: number
	readonly valid: boolean
}

interface DocumentRecord<T> {
	readonly id: string
	readonly path: string
	readonly data: T
}

type DecodeResult<T> =
	| { readonly success: true; readonly value: T }
	| { readonly success: false; readonly error: string }

const decode = <S extends Schema.Schema.AnyNoContext>(
	schema: S,
	input: unknown,
): DecodeResult<Schema.Schema.Type<S>> => {
	const result = Schema.decodeUnknownEither(schema, {
		errors: "all",
		onExcessProperty: "error",
	})(input)

	return Either.isLeft(result)
		? { success: false, error: TreeFormatter.formatErrorSync(result.left) }
		: { success: true, value: result.right }
}

const findCycles = (nodes: readonly Dependency[]): readonly string[] => {
	const dependencies = new Map(
		nodes.map((node) => [node.id, [...(node.dependsOn ?? [])]]),
	)
	const visiting = new Set<string>()
	const visited = new Set<string>()
	const cycles = new Set<string>()

	const visit = (id: string) => {
		if (visiting.has(id)) {
			cycles.add(id)
			return
		}
		if (visited.has(id)) {
			return
		}

		visiting.add(id)
		for (const dependency of dependencies.get(id) ?? []) {
			if (dependencies.has(dependency)) {
				visit(dependency)
			}
		}
		visiting.delete(id)
		visited.add(id)
	}

	for (const id of dependencies.keys()) {
		visit(id)
	}

	return [...cycles].sort()
}

export class WorkbaseService extends Effect.Service<WorkbaseService>()(
	"WorkbaseService",
	{
		sync: () => ({
			initialize: (path: string = process.cwd()) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const root = resolve(path)
					const configPath = join(root, "agency.json")

					if (yield* fs.exists(configPath)) {
						return yield* new WorkbaseConfigError({
							path: configPath,
							message: `Agency configuration already exists: ${configPath}`,
						})
					}

					yield* fs.createDirectory(root)
					yield* fs.writeJSON(configPath, { version: 2 })
					for (const directory of ["repos", "epics", "tasks"]) {
						yield* fs.createDirectory(join(root, directory))
					}

					const ignorePath = join(root, ".gitignore")
					const requiredPatterns = [
						"/repos/",
						"/tasks/*/code/",
						"/tasks/*/phases/*/code/",
					]
					const existing = (yield* fs.exists(ignorePath))
						? yield* fs.readFile(ignorePath)
						: ""
					const existingLines = new Set(existing.split(/\r?\n/))
					const missing = requiredPatterns.filter(
						(pattern) => !existingLines.has(pattern),
					)
					if (missing.length > 0) {
						const prefix =
							existing.length > 0 && !existing.endsWith("\n") ? "\n" : ""
						yield* fs.writeFile(
							ignorePath,
							`${existing}${prefix}${missing.join("\n")}\n`,
						)
					}

					return root
				}),

			discover: (startPath: string = process.cwd()) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					let current = resolve(startPath)

					if (!(yield* fs.isDirectory(current))) {
						current = dirname(current)
					}

					while (true) {
						const configPath = join(current, "agency.json")
						if (yield* fs.exists(configPath)) {
							const content = yield* fs.readFile(configPath)
							let input: unknown
							try {
								input = JSON.parse(content)
							} catch (cause) {
								return yield* new WorkbaseConfigError({
									path: configPath,
									message: `Invalid JSON in ${configPath}`,
									cause,
								})
							}

							if (
								typeof input === "object" &&
								input !== null &&
								"version" in input &&
								input.version === 2
							) {
								const decoded = decode(WorkbaseConfig, input)
								if (!decoded.success) {
									return yield* new WorkbaseConfigError({
										path: configPath,
										message: `Invalid workbase configuration in ${configPath}:\n${decoded.error}`,
									})
								}
								if (decoded.value.worktreeCreateCommand) {
									try {
										validateWorktreeCreateCommand(
											decoded.value.worktreeCreateCommand,
										)
									} catch (cause) {
										return yield* new WorkbaseConfigError({
											path: configPath,
											message:
												cause instanceof Error
													? cause.message
													: "Invalid worktreeCreateCommand",
										})
									}
								}
								return current
							}
						}

						const parent = dirname(current)
						if (parent === current) {
							return yield* new WorkbaseNotFoundError({
								message: `No Agency workbase found from ${resolve(startPath)}`,
							})
						}
						current = parent
					}
				}),

			loadConfig: (startPath: string = process.cwd()) =>
				Effect.gen(function* () {
					const service = yield* WorkbaseService
					const fs = yield* FileSystemService
					const root = yield* service.discover(startPath)
					const configPath = join(root, "agency.json")
					const content = yield* fs.readFile(configPath)
					let input: unknown
					try {
						input = JSON.parse(content)
					} catch (cause) {
						return yield* new WorkbaseConfigError({
							path: configPath,
							message: `Invalid JSON in ${configPath}`,
							cause,
						})
					}
					const decoded = decode(WorkbaseConfig, input)
					if (!decoded.success) {
						return yield* new WorkbaseConfigError({
							path: configPath,
							message: `Invalid workbase configuration in ${configPath}:\n${decoded.error}`,
						})
					}
					return { root, config: decoded.value }
				}),

			validate: (startPath: string = process.cwd()) =>
				Effect.gen(function* () {
					const service = yield* WorkbaseService
					const fs = yield* FileSystemService
					const root = yield* service.discover(startPath)
					const issues: ValidationIssue[] = []
					const epics = new Map<string, DocumentRecord<EpicData>>()
					const tasks = new Map<string, DocumentRecord<TaskData>>()
					const phases = new Map<string, DocumentRecord<PhaseData>>()

					const issue = (path: string, message: string) => {
						issues.push({ path: relative(root, path) || ".", message })
					}

					const readDirectories = (path: string) =>
						Effect.gen(function* () {
							if (!(yield* fs.isDirectory(path))) {
								return []
							}
							const entries = yield* fs.readDirectory(path)
							return entries
								.filter((entry) => entry.isDirectory)
								.map((entry) => entry.name)
								.sort()
						})

					const readAliases = Effect.gen(function* () {
						const reposPath = join(root, "repos")
						if (!(yield* fs.isDirectory(reposPath))) {
							return new Set<string>()
						}
						const entries = yield* fs.readDirectory(reposPath)
						return new Set(
							entries
								.filter((entry) => entry.isDirectory || entry.isSymlink)
								.map((entry) => entry.name),
						)
					})

					const aliases = yield* readAliases

					const readDocument = <S extends Schema.Schema.AnyNoContext>(
						path: string,
						schema: S,
					) =>
						Effect.gen(function* () {
							if (!(yield* fs.exists(path))) {
								issue(path, "Required document is missing")
								return null
							}

							const content = yield* fs.readFile(path)
							const parsed = yield* Effect.either(
								parseFrontmatter(content, path),
							)
							if (Either.isLeft(parsed)) {
								issue(path, parsed.left.message)
								return null
							}

							const decoded = decode(schema, parsed.right.data)
							if (!decoded.success) {
								issue(path, decoded.error)
								return null
							}
							return decoded.value
						})

					for (const id of yield* readDirectories(join(root, "epics"))) {
						const path = join(root, "epics", id, "EPIC.md")
						const data = yield* readDocument(path, EpicFrontmatter)
						if (data) {
							epics.set(id, { id, path, data })
						}
					}

					for (const id of yield* readDirectories(join(root, "tasks"))) {
						const taskPath = join(root, "tasks", id)
						const path = join(taskPath, "TASK.md")
						const data = yield* readDocument(path, TaskFrontmatter)
						if (data) {
							tasks.set(id, { id, path, data })
						}

						for (const phaseId of yield* readDirectories(
							join(taskPath, "phases"),
						)) {
							const phasePath = join(taskPath, "phases", phaseId, "PHASE.md")
							const phase = yield* readDocument(phasePath, PhaseFrontmatter)
							if (phase) {
								phases.set(`${id}/${phaseId}`, {
									id: phaseId,
									path: phasePath,
									data: phase,
								})
							}
						}
					}

					const validateRepositories = (
						record: DocumentRecord<EpicData | TaskData | PhaseData>,
					) => {
						const data = record.data
						const writable = "repo" in data ? data.repo : undefined
						const references = "repos" in data ? (data.repos ?? []) : []
						const referenceAliases = references.map(
							(reference) => reference.repo,
						)

						if (writable && referenceAliases.includes(writable)) {
							issue(
								record.path,
								`Repository '${writable}' cannot also be a reference`,
							)
						}

						const all = [writable, ...referenceAliases].filter(
							(alias): alias is string => alias !== undefined,
						)
						for (const alias of new Set(all)) {
							if (!aliases.has(alias)) {
								issue(record.path, `Unknown repository alias '${alias}'`)
							}
						}

						if (new Set(referenceAliases).size !== referenceAliases.length) {
							issue(record.path, "Repository references must be unique")
						}
					}

					const branchOwners = new Map<
						string,
						DocumentRecord<TaskData | PhaseData>
					>()
					const validateBranchOwnership = (
						record: DocumentRecord<TaskData | PhaseData>,
					) => {
						if (!("repo" in record.data)) return
						const key = `${record.data.repo}\u0000${record.data.branch}`
						const owner = branchOwners.get(key)
						if (owner) {
							issue(
								record.path,
								`Writable branch '${record.data.branch}' for repository '${record.data.repo}' is also owned by ${relative(root, owner.path)}`,
							)
						} else {
							branchOwners.set(key, record)
						}
					}

					for (const epic of epics.values()) {
						validateRepositories(epic)
						const ids = new Set(epic.data.tasks.map((task) => task.id))
						if (ids.size !== epic.data.tasks.length) {
							issue(epic.path, "Epic task IDs must be unique")
						}
						for (const task of epic.data.tasks) {
							const child = tasks.get(task.id)
							if (!child) {
								issue(epic.path, `Unknown child task '${task.id}'`)
							} else if (child.data.epic !== epic.id) {
								issue(
									child.path,
									`Task must reference parent epic '${epic.id}'`,
								)
							}
							for (const dependency of task.dependsOn ?? []) {
								if (!ids.has(dependency)) {
									issue(epic.path, `Unknown task dependency '${dependency}'`)
								}
							}
						}
						for (const cycle of findCycles(epic.data.tasks)) {
							issue(epic.path, `Task dependency cycle includes '${cycle}'`)
						}
					}

					for (const task of tasks.values()) {
						validateRepositories(task)
						validateBranchOwnership(task)
						if (task.data.epic) {
							const parent = epics.get(task.data.epic)
							if (!parent) {
								issue(task.path, `Unknown parent epic '${task.data.epic}'`)
							} else if (
								!parent.data.tasks.some((child) => child.id === task.id)
							) {
								issue(parent.path, `Epic does not list child task '${task.id}'`)
							}
						}

						const phasePrefix = `${task.id}/`
						const actualPhaseIds = [...phases.keys()]
							.filter((key) => key.startsWith(phasePrefix))
							.map((key) => key.slice(phasePrefix.length))

						if ("phases" in task.data) {
							const declaredIds = new Set(
								task.data.phases.map((phase) => phase.id),
							)
							if (declaredIds.size !== task.data.phases.length) {
								issue(task.path, "Task phase IDs must be unique")
							}
							for (const phase of task.data.phases) {
								if (!phases.has(`${task.id}/${phase.id}`)) {
									issue(task.path, `Missing phase '${phase.id}'`)
								}
								for (const dependency of phase.dependsOn ?? []) {
									if (!declaredIds.has(dependency)) {
										issue(task.path, `Unknown phase dependency '${dependency}'`)
									}
								}
							}
							for (const phaseId of actualPhaseIds) {
								if (!declaredIds.has(phaseId)) {
									issue(task.path, `Unlisted phase '${phaseId}'`)
								}
							}
							for (const cycle of findCycles(task.data.phases)) {
								issue(task.path, `Phase dependency cycle includes '${cycle}'`)
							}
						} else if (actualPhaseIds.length > 0) {
							issue(
								task.path,
								"Single-phase task cannot contain phase directories",
							)
						}
					}

					for (const phase of phases.values()) {
						validateRepositories(phase)
						validateBranchOwnership(phase)
					}

					issues.sort((a, b) =>
						a.path === b.path
							? a.message.localeCompare(b.message)
							: a.path.localeCompare(b.path),
					)

					return {
						root,
						issues,
						epicCount: epics.size,
						taskCount: tasks.size,
						phaseCount: phases.size,
						valid: issues.length === 0,
					} satisfies ValidationReport
				}),
		}),
	},
) {}
