import { Schema, TreeFormatter } from "@effect/schema"
import { Data, Effect, Either } from "effect"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { FileSystemService } from "./FileSystemService"
import { WorkbaseService, type ValidationReport } from "./WorkbaseService"
import { VersionControlService } from "./VersionControlService"
import { EpicService, type EpicRecord } from "./EpicService"
import {
	EntityId,
	PhaseFrontmatter,
	TaskFrontmatter,
	type RepositoryReference,
	type ReviewRecord,
	type TaskHandoff,
	type TaskPurpose,
	type TaskFrontmatter as TaskData,
	WorkStatus,
} from "../workbase/schemas"
import {
	formatMarkdownDocument,
	formatWorkDocumentBody,
	parseFrontmatter,
	parseFrontmatterSync,
} from "../workbase/frontmatter"
import { canTransitionStatus } from "../readiness"
import { documentRevision } from "../workbase/document-revision"
import { archivedTaskDirectory } from "../workbase/archive"
import {
	buildNonPrCompletion,
	type NonPrCompletionInput,
} from "../workbase/completion"
import {
	documentWriteStep,
	pathMustNotExistStep,
	runLifecycleTransaction,
	type TransactionStep,
} from "./LifecycleTransaction"

class TaskError extends Data.TaggedError("TaskError")<{
	readonly message: string
}> {}

export interface TaskRecord {
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
	readonly review?: ReviewRecord
	readonly purpose?: TaskPurpose
	readonly handoff?: TaskHandoff
	readonly preconditions?: readonly {
		readonly path: string
		readonly revision: string
	}[]
	readonly transactionSteps?: readonly TransactionStep[]
	readonly postWriteSteps?: readonly TransactionStep[]
}

export interface HandoffTaskInput {
	readonly sourceTaskId: string
	readonly sourcePhaseId?: string
	readonly id: string
	readonly ticketUrl: string | null
	readonly description?: string
	readonly epic?: string
	readonly repo: string
	readonly repos?: readonly RepositoryReference[]
	readonly branch: string
	readonly base: string
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

const decodePhase = (input: unknown) => {
	const result = Schema.decodeUnknownEither(PhaseFrontmatter, {
		errors: "all",
		onExcessProperty: "error",
	})(input)
	return Either.isLeft(result)
		? Effect.fail(
				new TaskError({ message: TreeFormatter.formatErrorSync(result.left) }),
			)
		: Effect.succeed(result.right)
}

const branchAvailableStep = (
	root: string,
	repo: string,
	branch: string,
	destinationId: string,
): TransactionStep => ({
	label: `verify branch ${repo}:${branch} is available`,
	preflight: async () => {
		const taskEntries = await readdir(join(root, "tasks"), {
			withFileTypes: true,
		}).catch(() => [])
		for (const taskEntry of taskEntries) {
			if (!taskEntry.isDirectory() || taskEntry.name === destinationId) continue
			const taskPath = join(root, "tasks", taskEntry.name, "TASK.md")
			const taskContent = await Bun.file(taskPath).text()
			const taskData = Schema.decodeUnknownSync(TaskFrontmatter, {
				errors: "all",
				onExcessProperty: "error",
			})(parseFrontmatterSync(taskContent, taskPath).data)
			if (
				"repo" in taskData &&
				taskData.repo === repo &&
				taskData.branch === branch
			) {
				throw new Error(
					`Writable branch '${branch}' for repository '${repo}' is already owned by task '${taskEntry.name}'`,
				)
			}
			if (!("phases" in taskData)) continue
			for (const phase of taskData.phases) {
				const phasePath = join(
					root,
					"tasks",
					taskEntry.name,
					"phases",
					phase.id,
					"PHASE.md",
				)
				const phaseContent = await Bun.file(phasePath).text()
				const phaseData = Schema.decodeUnknownSync(PhaseFrontmatter, {
					errors: "all",
					onExcessProperty: "error",
				})(parseFrontmatterSync(phaseContent, phasePath).data)
				if (phaseData.repo === repo && phaseData.branch === branch) {
					throw new Error(
						`Writable branch '${branch}' for repository '${repo}' is already owned by phase '${taskEntry.name}/${phase.id}'`,
					)
				}
			}
		}
	},
	apply: async () => {},
})

const reviewPinRef = (taskId: string) =>
	`refs/agency/reviews/${Buffer.from(taskId).toString("hex")}`

const reviewPinStep = (
	root: string,
	taskId: string,
	review: ReviewRecord,
	environment: Record<string, string>,
): TransactionStep => {
	const repositoryPath = join(root, "repos", review.repo)
	const ref = reviewPinRef(taskId)
	const run = async (args: readonly string[]) => {
		const child = Bun.spawn([...args], {
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, ...environment },
		})
		const [exitCode, stderr] = await Promise.all([
			child.exited,
			new Response(child.stderr).text(),
		])
		if (exitCode !== 0) throw new Error(stderr.trim() || args.join(" "))
	}
	return {
		label: `retain review pin for ${taskId}`,
		apply: () =>
			run([
				"git",
				"-C",
				repositoryPath,
				"update-ref",
				ref,
				review.commit,
				"0".repeat(40),
			]),
		rollback: () =>
			run([
				"git",
				"-C",
				repositoryPath,
				"update-ref",
				"-d",
				ref,
				review.commit,
			]),
		manualRecovery: `Delete ${ref} from repository '${review.repo}'`,
	}
}

export class TaskService extends Effect.Service<TaskService>()("TaskService", {
	sync: () => ({
		create: (input: CreateTaskInput, startPath: string = process.cwd()) =>
			Effect.gen(function* () {
				const fs = yield* FileSystemService
				const workbase = yield* WorkbaseService
				const epics = yield* EpicService
				const versionControl = yield* VersionControlService
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
						message: `Task '${id}' is archived; explicit creation requires a different ID`,
					})
				}
				const taskMetadata = {
					...(input.purpose ? { purpose: input.purpose } : {}),
					...(input.handoff ? { handoff: input.handoff } : {}),
				}
				if (input.handoff && input.purpose !== "implementation") {
					return yield* new TaskError({
						message:
							"Task handoff provenance requires purpose 'implementation'",
					})
				}
				if (input.purpose === "implementation" && !input.handoff) {
					return yield* new TaskError({
						message: "Implementation-purpose tasks require handoff provenance",
					})
				}

				let data: TaskData
				if (input.review) {
					if (
						input.multiPhase ||
						input.repo !== undefined ||
						input.repos !== undefined ||
						input.branch !== undefined ||
						input.base !== undefined
					) {
						return yield* new TaskError({
							message:
								"Review tasks cannot include writable or multi-phase fields",
						})
					}
					data = yield* decodeTask({
						ticketUrl: input.ticketUrl,
						...(input.description !== undefined
							? { description: input.description }
							: {}),
						...(input.epic ? { epic: input.epic } : {}),
						...taskMetadata,
						review: input.review,
					})
				} else if (input.multiPhase) {
					data = yield* decodeTask({
						ticketUrl: input.ticketUrl,
						...(input.description !== undefined
							? { description: input.description }
							: {}),
						...(input.epic ? { epic: input.epic } : {}),
						...taskMetadata,
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
						...taskMetadata,
						repo: input.repo,
						...(input.repos?.length ? { repos: input.repos } : {}),
						branch: input.branch,
						base: input.base,
						pr: null,
					})
				}

				const referencedRepos =
					"review" in data
						? [data.review.repo]
						: "repo" in data
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
					if (!(yield* workbase.hasRepositoryAlias(alias, root))) {
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
					formatWorkDocumentBody(title, "task", input.purpose),
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
				let reviewEnvironment: Record<string, string> = {}
				if (input.review) {
					const backend = yield* versionControl.forWorkbase(root)
					reviewEnvironment = yield* backend.gitEnvironment(
						join(root, "repos", input.review.repo),
					)
				}
				yield* runLifecycleTransaction({
					root,
					preconditions: [
						...(input.preconditions ?? []),
						...(parentEpic
							? [{ path: parentEpic.path, revision: parentEpic.revision }]
							: []),
					],
					steps: [
						...(input.transactionSteps ?? []),
						pathMustNotExistStep(
							root,
							directory,
							`Task '${id}' already exists`,
						),
						pathMustNotExistStep(
							root,
							archivedTaskDirectory(root, id),
							`Task '${id}' is archived; explicit creation requires a different ID`,
						),
						...(input.review
							? [reviewPinStep(root, id, input.review, reviewEnvironment)]
							: []),
						documentWriteStep(root, writes),
						...(input.postWriteSteps ?? []),
					],
				})

				return {
					id,
					path,
					content,
					revision: documentRevision(content),
					data,
				} satisfies TaskRecord
			}),

		handoff: (input: HandoffTaskInput, startPath: string = process.cwd()) =>
			Effect.gen(function* () {
				const fs = yield* FileSystemService
				const workbase = yield* WorkbaseService
				const service = yield* TaskService
				const root = yield* workbase.discover(startPath)
				const sourceTaskId = yield* decodeId(input.sourceTaskId)
				const sourceTask = yield* service.show(sourceTaskId, root)
				const validation = yield* workbase.validate(root)
				if (!validation.valid) {
					return yield* new TaskError({
						message: "Cannot create a handoff in an invalid workbase",
					})
				}
				if (sourceTask.data.purpose !== "investigation") {
					return yield* new TaskError({
						message: `Task '${sourceTaskId}' is not an investigation task`,
					})
				}

				const preconditions = [
					{ path: sourceTask.path, revision: sourceTask.revision },
				]
				let source: TaskHandoff["source"]
				let committedValidation: ValidationReport | undefined
				let sourcePath = sourceTask.path
				let sourceRevision = sourceTask.revision
				if (input.sourcePhaseId) {
					const phaseId = yield* decodeId(input.sourcePhaseId)
					if (
						!("phases" in sourceTask.data) ||
						!sourceTask.data.phases.some((phase) => phase.id === phaseId)
					) {
						return yield* new TaskError({
							message: `Phase '${sourceTaskId}/${phaseId}' does not exist`,
						})
					}
					sourcePath = join(
						root,
						"tasks",
						sourceTaskId,
						"phases",
						phaseId,
						"PHASE.md",
					)
					const sourceContent = yield* fs.readFile(sourcePath)
					const parsed = yield* parseFrontmatter(sourceContent, sourcePath)
					yield* decodePhase(parsed.data)
					sourceRevision = documentRevision(sourceContent)
					preconditions.push({ path: sourcePath, revision: sourceRevision })
					source = { kind: "phase", taskId: sourceTaskId, phaseId }
				} else {
					source = { kind: "task", taskId: sourceTaskId }
				}

				const record = yield* service.create(
					{
						id: input.id,
						ticketUrl: input.ticketUrl,
						description: input.description,
						epic: input.epic,
						repo: input.repo,
						repos: input.repos,
						branch: input.branch,
						base: input.base,
						purpose: "implementation",
						handoff: { source, sourceRevision },
						preconditions,
						transactionSteps: [
							branchAvailableStep(root, input.repo, input.branch, input.id),
						],
						postWriteSteps: [
							{
								label: "validate resulting workbase",
								apply: async () => {
									const report = await Effect.runPromise(
										workbase
											.validate(root)
											.pipe(
												Effect.provideService(FileSystemService, fs),
												Effect.provideService(WorkbaseService, workbase),
											),
									)
									if (!report.valid) {
										throw new Error(
											`Handoff would create an invalid workbase: ${report.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
										)
									}
									committedValidation = report
								},
							},
						],
					},
					root,
				)
				if (!("repo" in record.data)) {
					return yield* new TaskError({
						message: `Task '${record.id}' is not an implementation execution unit`,
					})
				}
				if (!committedValidation) {
					return yield* new TaskError({
						message: "Handoff validation did not produce a result",
					})
				}
				const taskDirectory = join(root, "tasks", record.id)
				const sourceSelector =
					source.kind === "phase"
						? `phase/${source.taskId}/${source.phaseId}`
						: `task/${source.taskId}`
				return {
					task: {
						id: record.id,
						selector: `task/${record.id}`,
						directory: taskDirectory,
						documentPath: record.path,
						revision: record.revision,
						branch: record.data.branch,
						base: record.data.base,
					},
					source: {
						selector: sourceSelector,
						documentPath: sourcePath,
						revision: sourceRevision,
					},
					validation: committedValidation,
					worktreePrepare: {
						target: `task/${record.id}`,
						command: ["agency", "worktree", "prepare", record.id],
					},
				}
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
			nonPrCompletion?: NonPrCompletionInput,
		) =>
			Effect.gen(function* () {
				const fs = yield* FileSystemService
				const service = yield* TaskService
				const validStatus = yield* decodeStatus(status)
				if (validStatus === "delegated") {
					return yield* new TaskError({
						message:
							"Delegation requires explicit ownership; use 'agency claim'",
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
				if (nonPrCompletion && validStatus !== "done") {
					return yield* new TaskError({
						message: "Non-PR completion is valid only with a done status",
					})
				}
				if (nonPrCompletion && "pr" in record.data && record.data.pr !== null) {
					return yield* new TaskError({
						message:
							"Cannot complete without a pull request while an authoritative pull request is recorded",
					})
				}
				const completionResult = nonPrCompletion
					? buildNonPrCompletion(nonPrCompletion, new Date())
					: undefined
				if (completionResult && "error" in completionResult) {
					return yield* new TaskError({ message: completionResult.error })
				}
				if (
					completionResult &&
					record.data.status !== "open" &&
					record.data.status !== "working" &&
					record.data.status !== "delegated"
				) {
					return yield* new TaskError({
						message: `Cannot transition task '${id}' from ${record.data.status} to done; reopen it first`,
					})
				}
				if (
					!canTransitionStatus(record.data.status, validStatus) &&
					!completionResult
				) {
					if (validStatus === "done") {
						return yield* new TaskError({
							message:
								"Work becomes done after its authoritative pull request is merged; run 'agency sync', or explicitly complete a non-PR outcome with '--no-pull-request --summary <text>'",
						})
					}
					return yield* new TaskError({
						message: `Cannot transition task '${id}' from ${record.data.status} to ${validStatus}; reopen it first`,
					})
				}
				const parsed = yield* parseFrontmatter(record.content, record.path)
				const { completion: _, ...withoutCompletion } = record.data
				const data: TaskData = completionResult
					? {
							...record.data,
							status: "done",
							completion: completionResult.value,
						}
					: validStatus === "open"
						? { ...withoutCompletion, status: validStatus }
						: { ...record.data, status: validStatus }
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
