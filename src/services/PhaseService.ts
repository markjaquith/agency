import { Schema, TreeFormatter } from "@effect/schema"
import { Data, Effect, Either } from "effect"
import { lstat, mkdir, readdir, realpath, rename, rm } from "node:fs/promises"
import { join } from "node:path"
import { FileSystemService } from "./FileSystemService"
import { WorkbaseService } from "./WorkbaseService"
import { TaskService } from "./TaskService"
import {
	EntityId,
	PhaseFrontmatter,
	type PhaseFrontmatter as PhaseData,
	type RepositoryReference,
	WorkStatus,
} from "../workbase/schemas"
import {
	formatMarkdownDocument,
	parseFrontmatter,
} from "../workbase/frontmatter"
import { canTransitionStatus } from "../readiness"
import { documentRevision } from "../workbase/document-revision"
import { archivedPhaseDirectory } from "../workbase/archive"
import {
	documentWriteStep,
	runLifecycleTransaction,
	type TransactionStep,
} from "./LifecycleTransaction"
import { withWorktreeLocks } from "./WorktreeLock"

class PhaseError extends Data.TaggedError("PhaseError")<{
	readonly message: string
}> {}

export interface PhaseRecord {
	readonly taskId: string
	readonly id: string
	readonly path: string
	readonly content: string
	readonly revision: string
	readonly data: PhaseData
}

export interface CreatePhaseInput {
	readonly taskId: string
	readonly id: string
	readonly description?: string
	readonly repo: string
	readonly repos?: readonly RepositoryReference[]
	readonly branch: string
	readonly base: string
	readonly dependsOn?: readonly string[]
	readonly firstPhase?: string
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

const decodeStatus = (status: string) => {
	const result = Schema.decodeUnknownEither(WorkStatus)(status)
	return Either.isLeft(result)
		? Effect.fail(
				new PhaseError({ message: `Invalid work status '${status}'` }),
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
					const isMultiPhase = "phases" in task.data
					let firstPhaseId: string | undefined
					if (!isMultiPhase) {
						if (!input.firstPhase) {
							return yield* new PhaseError({
								message:
									"Converting a single-phase task requires --first-phase <id>",
							})
						}
						firstPhaseId = yield* decodeId(input.firstPhase, "first phase")
						if (firstPhaseId === id) {
							return yield* new PhaseError({
								message: "The existing and new phase IDs must be different",
							})
						}
					} else if (input.firstPhase) {
						return yield* new PhaseError({
							message:
								"--first-phase is only valid when converting a single-phase task",
						})
					}

					if (
						isMultiPhase &&
						task.data.phases.some((phase) => phase.id === id)
					) {
						return yield* new PhaseError({
							message: `Phase '${id}' already exists on task '${taskId}'`,
						})
					}
					if (yield* fs.exists(archivedPhaseDirectory(root, taskId, id))) {
						return yield* new PhaseError({
							message: `Phase '${id}' on task '${taskId}' is archived; restore it before reusing this ID`,
						})
					}
					const knownPhases = new Set(
						isMultiPhase
							? task.data.phases.map((phase) => phase.id)
							: [firstPhaseId!],
					)
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
					const existingExecution = isMultiPhase ? undefined : task.data
					const aliases = new Set([
						data.repo,
						...(data.repos ?? []).map((reference) => reference.repo),
						...(existingExecution
							? [
									existingExecution.repo,
									...(existingExecution.repos ?? []).map(
										(reference) => reference.repo,
									),
								]
							: []),
					])
					const newAliases = [
						data.repo,
						...(data.repos ?? []).map((reference) => reference.repo),
					]
					if (new Set(newAliases).size !== newAliases.length) {
						return yield* new PhaseError({
							message:
								"Repository references must be unique and cannot include the writable repository",
						})
					}
					for (const alias of aliases) {
						if (!(yield* workbase.hasRepositoryAlias(alias, root))) {
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

					const parsedTask = yield* parseFrontmatter(task.content, task.path)
					const title = id
						.split("-")
						.map((part) => part[0]?.toUpperCase() + part.slice(1))
						.join(" ")
					const content = formatMarkdownDocument(
						data,
						`# ${title}\n\nDescribe the phase outcome.`,
					)

					if (!isMultiPhase) {
						const firstDirectory = join(
							root,
							"tasks",
							taskId,
							"phases",
							firstPhaseId!,
						)
						if (yield* fs.exists(firstDirectory)) {
							return yield* new PhaseError({
								message: `Phase directory already exists: ${firstPhaseId}`,
							})
						}
						const firstData = yield* decodePhase({
							repo: task.data.repo,
							...(task.data.repos?.length ? { repos: task.data.repos } : {}),
							branch: task.data.branch,
							base: task.data.base,
							pr: task.data.pr,
							status: task.data.status,
							...(task.data.claim ? { claim: task.data.claim } : {}),
						})
						const firstTitle = firstPhaseId!
							.split("-")
							.map((part) => part[0]?.toUpperCase() + part.slice(1))
							.join(" ")

						const oldCodePath = join(root, "tasks", taskId, "code")
						const convertedTaskData = {
							ticketUrl: task.data.ticketUrl,
							...(task.data.description
								? { description: task.data.description }
								: {}),
							...(task.data.epic ? { epic: task.data.epic } : {}),
							phases: [
								{ id: firstPhaseId! },
								{
									id,
									...(input.dependsOn?.length
										? { dependsOn: input.dependsOn }
										: {}),
								},
							],
						}
						const firstPhasePath = join(firstDirectory, "PHASE.md")
						const firstContent = formatMarkdownDocument(
							firstData,
							`# ${firstTitle}\n\nDescribe the phase outcome.`,
						)
						const steps: TransactionStep[] = []
						if (yield* fs.isDirectory(oldCodePath)) {
							const firstCodePath = join(firstDirectory, "code")
							const checkoutAliases = [
								firstData.repo,
								...(firstData.repos ?? []).map((reference) => reference.repo),
							]
							const repair = async (basePath: string) => {
								for (const alias of checkoutAliases) {
									const checkoutPath = join(basePath, alias)
									try {
										await lstat(checkoutPath)
									} catch {
										continue
									}
									const result = Bun.spawnSync([
										"git",
										"-C",
										join(root, "repos", alias),
										"worktree",
										"repair",
										checkoutPath,
									])
									if (result.exitCode !== 0) {
										throw new Error(
											`Failed to repair moved worktree for '${alias}': ${new TextDecoder().decode(result.stderr)}`,
										)
									}
								}
							}
							steps.push({
								label: `move and repair code for ${taskId}/${firstPhaseId}`,
								preflight: async () => {
									for (const entry of await readdir(oldCodePath)) {
										if (!checkoutAliases.includes(entry))
											throw new Error(
												`Cannot convert task '${taskId}'; code contains unmanaged entry '${entry}'`,
											)
									}
									for (const alias of checkoutAliases) {
										const checkoutPath = join(oldCodePath, alias)
										try {
											await lstat(checkoutPath)
										} catch {
											continue
										}
										const listed = Bun.spawnSync([
											"git",
											"-C",
											join(root, "repos", alias),
											"worktree",
											"list",
											"--porcelain",
										])
										if (listed.exitCode !== 0)
											throw new Error(
												`Failed to inspect worktrees for '${alias}'`,
											)
										const expected = await realpath(checkoutPath)
										let registered = false
										for (const line of new TextDecoder()
											.decode(listed.stdout)
											.split("\n")) {
											if (!line.startsWith("worktree ")) continue
											try {
												if ((await realpath(line.slice(9))) === expected) {
													registered = true
													break
												}
											} catch {}
										}
										if (!registered)
											throw new Error(
												`Cannot convert task '${taskId}'; checkout '${alias}' is not registered as a Git worktree`,
											)
									}
								},
								apply: async () => {
									await mkdir(firstDirectory, { recursive: true })
									await rename(oldCodePath, firstCodePath)
									try {
										await repair(firstCodePath)
									} catch (cause) {
										await rename(firstCodePath, oldCodePath)
										await repair(oldCodePath)
										await rm(firstDirectory, { recursive: true, force: true })
										throw cause
									}
								},
								rollback: async () => {
									await rename(firstCodePath, oldCodePath)
									await repair(oldCodePath)
									await rm(firstDirectory, { recursive: true, force: true })
								},
								manualRecovery: `Move ${firstCodePath} back to ${oldCodePath} and run git worktree repair`,
							})
						}
						steps.push(
							documentWriteStep(root, [
								{ path: firstPhasePath, content: firstContent, create: true },
								{ path, content, create: true },
								{
									path: task.path,
									content: formatMarkdownDocument(
										convertedTaskData,
										parsedTask.body,
									),
								},
							]),
						)
						yield* withWorktreeLocks(
							root,
							[{ taskId }],
							runLifecycleTransaction({
								root,
								preconditions: [{ path: task.path, revision: task.revision }],
								steps,
							}),
						)
						return {
							taskId,
							id,
							path,
							content,
							revision: documentRevision(content),
							data,
						} satisfies PhaseRecord
					}

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
					yield* runLifecycleTransaction({
						root,
						preconditions: [{ path: task.path, revision: task.revision }],
						steps: [
							documentWriteStep(root, [
								{ path, content, create: true },
								{
									path: task.path,
									content: formatMarkdownDocument(
										updatedTaskData,
										parsedTask.body,
									),
								},
							]),
						],
					})

					return {
						taskId,
						id,
						path,
						content,
						revision: documentRevision(content),
						data,
					} satisfies PhaseRecord
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
							revision: documentRevision(content),
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

			setStatus: (
				taskId: string,
				id: string,
				status: string,
				startPath: string = process.cwd(),
			) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const service = yield* PhaseService
					const validStatus = yield* decodeStatus(status)
					if (validStatus === "working" || validStatus === "delegated") {
						return yield* new PhaseError({
							message:
								"Active work and delegation require explicit ownership; use 'agency claim'",
						})
					}
					const record = yield* service.show(taskId, id, startPath)
					if (record.data.claim?.state === "active") {
						return yield* new PhaseError({
							message: `Phase '${id}' has an active claim; use agency release or agency finish`,
						})
					}
					if (!canTransitionStatus(record.data.status, validStatus)) {
						return yield* new PhaseError({
							message: `Cannot transition phase '${id}' from ${record.data.status} to ${validStatus}; reopen it first`,
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
					} satisfies PhaseRecord
				}),
		}),
	},
) {}
