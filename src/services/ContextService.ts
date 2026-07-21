import { Schema, TreeFormatter } from "@effect/schema"
import { Data, Effect, Either } from "effect"
import { join, relative, resolve, sep } from "node:path"
import { FileSystemService } from "./FileSystemService"
import { WorkbaseService } from "./WorkbaseService"
import { normalizePullRequestRecord } from "../workbase/delivery-command"
import { RepositoryService } from "./RepositoryService"
import { aggregateProgress, readinessState } from "../readiness"
import { parseFrontmatter } from "../workbase/frontmatter"
import { documentRevision } from "../workbase/document-revision"
import {
	EpicFrontmatter,
	PhaseFrontmatter,
	TaskFrontmatter,
	type Dependency,
	type EpicFrontmatter as EpicData,
	type PhaseFrontmatter as PhaseData,
	type RepositoryReference,
	type TaskFrontmatter as TaskData,
	type WorkStatus,
} from "../workbase/schemas"

class ContextError extends Data.TaggedError("ContextError")<{
	readonly message: string
	readonly target?: string
}> {}

interface Document<T> {
	readonly id: string
	readonly path: string
	readonly sha256: string
	readonly data: T
	readonly body: string
}

interface Target {
	readonly kind: "epic" | "task" | "phase"
	readonly epicId?: string
	readonly taskId?: string
	readonly phaseId?: string
	readonly path: string
}

interface ExecutionRecord {
	readonly kind: "task" | "phase"
	readonly taskId: string
	readonly phaseId?: string
	readonly data: TaskData | PhaseData
}

interface CheckoutInspection {
	readonly materialized: boolean
	readonly registered: boolean
	readonly checkoutCommit: string | null
	readonly checkoutBranch: string | null
	readonly detached: boolean | null
}

type ExecutionData = PhaseData & Partial<Pick<TaskData, "ticketUrl" | "epic">>

interface ReferenceCheckout extends CheckoutInspection {
	readonly repo: string
	readonly ref: string
	readonly repositoryPath: string
	readonly checkoutPath: string
	readonly resolvedCommit: string | null
}

const decode = <S extends Schema.Schema.AnyNoContext>(
	schema: S,
	input: unknown,
) => {
	const result = Schema.decodeUnknownEither(schema, {
		errors: "all",
		onExcessProperty: "error",
	})(input)
	return Either.isLeft(result)
		? { ok: false as const, error: TreeFormatter.formatErrorSync(result.left) }
		: { ok: true as const, value: result.right }
}

const isWithin = (root: string, path: string) => {
	const child = relative(root, path)
	return child === "" || (!child.startsWith(`..${sep}`) && child !== "..")
}

const runGit = (fs: FileSystemService, cwd: string, args: readonly string[]) =>
	fs.runCommand(["git", "-C", cwd, ...args], { captureOutput: true }).pipe(
		Effect.map((result) =>
			result.exitCode === 0 ? result.stdout.trim() || null : null,
		),
		Effect.catchAll(() => Effect.succeed(null)),
	)

const worktreePaths = (output: string | null) =>
	new Set(
		(output ?? "")
			.split("\n")
			.filter((line) => line.startsWith("worktree "))
			.map((line) => line.slice("worktree ".length)),
	)

export class ContextService extends Effect.Service<ContextService>()(
	"ContextService",
	{
		sync: () => ({
			get: (options: {
				readonly target?: string
				readonly cwd?: string
				readonly compact?: boolean
				readonly full?: boolean
			}) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const workbase = yield* WorkbaseService
					const repositoryService = yield* RepositoryService
					const cwd = resolve(options.cwd ?? process.cwd())
					const suppliedTarget = options.target ?? "."
					const candidate = resolve(cwd, suppliedTarget)
					const candidateExists = yield* fs.exists(candidate)
					const { root, config } = yield* workbase.loadConfig(
						candidateExists ? candidate : cwd,
					)

					if (relative(root, candidate) === "") {
						const compact = !options.full
						const discover = <S extends Schema.Schema.AnyNoContext>(
							id: string,
							path: string,
							schema: S,
							extra: Record<string, string> = {},
						) =>
							Effect.gen(function* () {
								if (!(yield* fs.exists(path))) return null
								const content = yield* fs.readFile(path)
								const parsed = yield* Effect.either(
									parseFrontmatter(content, path),
								)
								if (Either.isLeft(parsed)) return null
								const decoded = decode(schema, parsed.right.data)
								if (!decoded.ok) return null
								return {
									...extra,
									id,
									path,
									sha256: documentRevision(content),
									data: decoded.value,
									...(compact ? {} : { body: parsed.right.body }),
								}
							})

						const epics: unknown[] = []
						const tasks: unknown[] = []
						const phases: unknown[] = []
						const epicRoot = join(root, "epics")
						if (yield* fs.isDirectory(epicRoot)) {
							for (const entry of (yield* fs.readDirectory(epicRoot))
								.filter((item) => item.isDirectory)
								.sort((a, b) => a.name.localeCompare(b.name))) {
								const document = yield* discover(
									entry.name,
									join(epicRoot, entry.name, "EPIC.md"),
									EpicFrontmatter,
								)
								if (document) epics.push(document)
							}
						}

						const taskRoot = join(root, "tasks")
						if (yield* fs.isDirectory(taskRoot)) {
							for (const entry of (yield* fs.readDirectory(taskRoot))
								.filter((item) => item.isDirectory)
								.sort((a, b) => a.name.localeCompare(b.name))) {
								const document = yield* discover(
									entry.name,
									join(taskRoot, entry.name, "TASK.md"),
									TaskFrontmatter,
								)
								if (document) tasks.push(document)

								const phaseRoot = join(taskRoot, entry.name, "phases")
								if (!(yield* fs.isDirectory(phaseRoot))) continue
								for (const phaseEntry of (yield* fs.readDirectory(phaseRoot))
									.filter((item) => item.isDirectory)
									.sort((a, b) => a.name.localeCompare(b.name))) {
									const phase = yield* discover(
										phaseEntry.name,
										join(phaseRoot, phaseEntry.name, "PHASE.md"),
										PhaseFrontmatter,
										{ taskId: entry.name },
									)
									if (phase) phases.push(phase)
								}
							}
						}

						const validation = yield* workbase.validate(root)
						return {
							projection: compact ? "compact" : "complete",
							workbase: {
								root,
								configPath: join(root, "agency.json"),
								version: config.version,
							},
							target: { kind: "workbase", path: root },
							hint: compact
								? "Run agency context . --full --json to include document prose."
								: null,
							discovery: { epics, tasks, phases },
							authority: {
								mode: "orchestration",
								writable: null,
								references: [],
							},
							validation: {
								valid: validation.valid,
								warnings: validation.issues,
							},
						}
					}

					const inferTarget = (): Target | null => {
						if (!candidateExists && !suppliedTarget.includes(sep)) {
							return {
								kind: "task",
								taskId: suppliedTarget,
								path: join(root, "tasks", suppliedTarget, "TASK.md"),
							}
						}
						if (!isWithin(root, candidate)) return null
						const parts = relative(root, candidate).split(sep)
						if (parts[0] === "epics" && parts[1]) {
							return {
								kind: "epic",
								epicId: parts[1],
								path: join(root, "epics", parts[1], "EPIC.md"),
							}
						}
						if (parts[0] === "tasks" && parts[1]) {
							if (parts[2] === "phases" && parts[3]) {
								return {
									kind: "phase",
									taskId: parts[1],
									phaseId: parts[3],
									path: join(
										root,
										"tasks",
										parts[1],
										"phases",
										parts[3],
										"PHASE.md",
									),
								}
							}
							return {
								kind: "task",
								taskId: parts[1],
								path: join(root, "tasks", parts[1], "TASK.md"),
							}
						}
						return null
					}

					const target = inferTarget()
					if (!target) {
						return yield* new ContextError({
							target: suppliedTarget,
							message: `Cannot infer an Agency target from ${candidate}`,
						})
					}

					const readDocument = <S extends Schema.Schema.AnyNoContext>(
						id: string,
						path: string,
						schema: S,
					) =>
						Effect.gen(function* () {
							if (!(yield* fs.exists(path))) {
								return yield* new ContextError({
									target: suppliedTarget,
									message: `Target document does not exist: ${path}`,
								})
							}
							const content = yield* fs.readFile(path)
							const parsed = yield* parseFrontmatter(content, path).pipe(
								Effect.mapError(
									(error) =>
										new ContextError({
											target: suppliedTarget,
											message: `Invalid target document ${path}: ${error.message}`,
										}),
								),
							)
							const decoded = decode(schema, parsed.data)
							if (!decoded.ok) {
								return yield* new ContextError({
									target: suppliedTarget,
									message: `Invalid target document ${path}:\n${decoded.error}`,
								})
							}
							return {
								id,
								path,
								sha256: documentRevision(content),
								data: decoded.value,
								body: parsed.body,
							} satisfies Document<Schema.Schema.Type<S>>
						})

					const readOptionalDocument = <S extends Schema.Schema.AnyNoContext>(
						id: string,
						path: string,
						schema: S,
					) =>
						Effect.gen(function* () {
							if (!(yield* fs.exists(path))) return null
							return yield* readDocument(id, path, schema)
						})

					const task = target.taskId
						? yield* readDocument(
								target.taskId,
								join(root, "tasks", target.taskId, "TASK.md"),
								TaskFrontmatter,
							)
						: null
					const phase = target.phaseId
						? yield* readDocument(
								target.phaseId,
								join(
									root,
									"tasks",
									target.taskId!,
									"phases",
									target.phaseId,
									"PHASE.md",
								),
								PhaseFrontmatter,
							)
						: null
					const epicId =
						target.epicId ??
						(task?.data && "epic" in task.data ? task.data.epic : undefined)
					const epic = epicId
						? yield* readOptionalDocument(
								epicId,
								join(root, "epics", epicId, "EPIC.md"),
								EpicFrontmatter,
							)
						: null
					if (target.kind === "epic" && !epic) {
						return yield* new ContextError({
							target: suppliedTarget,
							message: `Target document does not exist: ${target.path}`,
						})
					}

					const taskDocuments = new Map<string, Document<TaskData>>()
					const phaseDocuments = new Map<string, Document<PhaseData>>()
					const taskRoot = join(root, "tasks")
					if (yield* fs.isDirectory(taskRoot)) {
						const entries = (yield* fs.readDirectory(taskRoot))
							.filter((entry) => entry.isDirectory)
							.sort((a, b) => a.name.localeCompare(b.name))
						for (const entry of entries) {
							const path = join(taskRoot, entry.name, "TASK.md")
							if (!(yield* fs.exists(path))) continue
							const content = yield* fs.readFile(path)
							const parsed = yield* Effect.either(
								parseFrontmatter(content, path),
							)
							if (Either.isLeft(parsed)) continue
							const decoded = decode(TaskFrontmatter, parsed.right.data)
							if (!decoded.ok) continue
							taskDocuments.set(entry.name, {
								id: entry.name,
								path,
								sha256: documentRevision(content),
								data: decoded.value,
								body: parsed.right.body,
							})
							const phasesPath = join(taskRoot, entry.name, "phases")
							if (!(yield* fs.isDirectory(phasesPath))) continue
							for (const phaseEntry of (yield* fs.readDirectory(phasesPath))
								.filter((item) => item.isDirectory)
								.sort((a, b) => a.name.localeCompare(b.name))) {
								const phasePath = join(phasesPath, phaseEntry.name, "PHASE.md")
								if (!(yield* fs.exists(phasePath))) continue
								const phaseContent = yield* fs.readFile(phasePath)
								const phaseParsed = yield* Effect.either(
									parseFrontmatter(phaseContent, phasePath),
								)
								if (Either.isLeft(phaseParsed)) continue
								const phaseDecoded = decode(
									PhaseFrontmatter,
									phaseParsed.right.data,
								)
								if (!phaseDecoded.ok) continue
								phaseDocuments.set(`${entry.name}/${phaseEntry.name}`, {
									id: phaseEntry.name,
									path: phasePath,
									sha256: documentRevision(phaseContent),
									data: phaseDecoded.value,
									body: phaseParsed.right.body,
								})
							}
						}
					}

					const executionStatus = (record: ExecutionRecord): WorkStatus => {
						if (record.kind === "phase")
							return (record.data as PhaseData).status
						const data = record.data as TaskData
						if (!("phases" in data)) return data.status
						return aggregateProgress(
							data.phases.map(
								(item) =>
									phaseDocuments.get(`${record.taskId}/${item.id}`)?.data
										.status ?? "open",
							),
						).status
					}

					const taskDependencyEntries = (
						taskId: string,
					): readonly Dependency[] => {
						const parentId =
							taskDocuments.get(taskId)?.data &&
							"epic" in taskDocuments.get(taskId)!.data
								? taskDocuments.get(taskId)!.data.epic
								: undefined
						if (!parentId) return []
						if (epic?.id === parentId) return epic.data.tasks
						return []
					}

					const dependencyStatus = (taskId: string): WorkStatus => {
						const document = taskDocuments.get(taskId)
						return document
							? executionStatus({ kind: "task", taskId, data: document.data })
							: "open"
					}
					const taskDependencies = (taskId: string) =>
						taskDependencyEntries(taskId).find((item) => item.id === taskId)
							?.dependsOn ?? []
					const taskReady = (taskId: string): boolean => {
						if (
							taskDependencies(taskId).some(
								(dependency) => dependencyStatus(dependency) !== "done",
							)
						) {
							return false
						}
						const document = taskDocuments.get(taskId)
						if (!document) return false
						if (!("phases" in document.data))
							return document.data.status === "open"
						return document.data.phases.some((item) => {
							const status = phaseDocuments.get(`${taskId}/${item.id}`)?.data
								.status
							return (
								status === "open" &&
								(item.dependsOn ?? []).every(
									(dependency) =>
										phaseDocuments.get(`${taskId}/${dependency}`)?.data
											.status === "done",
								)
							)
						})
					}

					const validation = yield* workbase.validate(root)
					const relevantPaths = new Set<string>(
						[epic?.path, task?.path, phase?.path]
							.filter((path): path is string => Boolean(path))
							.map((path) => relative(root, path)),
					)
					if (target.kind === "task" && target.taskId) {
						for (const [key, document] of phaseDocuments) {
							if (key.startsWith(`${target.taskId}/`)) {
								relevantPaths.add(relative(root, document.path))
							}
						}
					}
					if (target.kind === "epic" && epic) {
						for (const child of epic.data.tasks) {
							const childTask = taskDocuments.get(child.id)
							if (childTask) relevantPaths.add(relative(root, childTask.path))
							for (const [key, document] of phaseDocuments) {
								if (key.startsWith(`${child.id}/`)) {
									relevantPaths.add(relative(root, document.path))
								}
							}
						}
					}
					const blockers: Array<{
						kind: "dependency" | "validation" | "status"
						id: string
						status?: WorkStatus
						reason: string
					}> = []

					let dependencies: readonly string[] = []
					let dependents: readonly string[] = []
					let targetStatus: WorkStatus = "open"
					let aggregateStatuses: WorkStatus[] = []
					let descendantsReady = false

					if (target.kind === "phase" && task && phase) {
						const phaseEntries: readonly Dependency[] =
							"phases" in task.data ? task.data.phases : []
						const declaration = phaseEntries.find(
							(item: Dependency) => item.id === target.phaseId,
						)
						dependencies = [...(declaration?.dependsOn ?? [])].sort()
						dependents = phaseEntries
							.filter((item: Dependency) =>
								item.dependsOn?.includes(target.phaseId!),
							)
							.map((item: Dependency) => item.id)
							.sort()
						targetStatus = phase.data.status
						aggregateStatuses = [targetStatus]
						for (const dependency of dependencies) {
							const status = phaseDocuments.get(
								`${target.taskId}/${dependency}`,
							)?.data.status
							if (status !== "done") {
								blockers.push({
									kind: "dependency",
									id: dependency,
									status,
									reason: status
										? `Phase dependency is ${status}`
										: "Phase dependency is missing",
								})
							}
						}
						for (const dependency of taskDependencies(target.taskId!)) {
							const status = dependencyStatus(dependency)
							if (status !== "done") {
								blockers.push({
									kind: "dependency",
									id: dependency,
									status,
									reason: `Parent task dependency is ${status}`,
								})
							}
						}
					} else if (target.kind === "task" && task) {
						const entries = taskDependencyEntries(target.taskId!)
						const declaration = entries.find(
							(item) => item.id === target.taskId,
						)
						dependencies = [...(declaration?.dependsOn ?? [])].sort()
						dependents = entries
							.filter((item) => item.dependsOn?.includes(target.taskId!))
							.map((item) => item.id)
							.sort()
						targetStatus = executionStatus({
							kind: "task",
							taskId: target.taskId!,
							data: task.data,
						})
						aggregateStatuses =
							"phases" in task.data
								? task.data.phases.map(
										(item: Dependency) =>
											phaseDocuments.get(`${target.taskId}/${item.id}`)?.data
												.status ?? "open",
									)
								: [task.data.status]
						descendantsReady = taskReady(target.taskId!)
						for (const dependency of dependencies) {
							const status = dependencyStatus(dependency)
							if (status !== "done") {
								blockers.push({
									kind: "dependency",
									id: dependency,
									status,
									reason: `Task dependency is ${status}`,
								})
							}
						}
						if ("phases" in task.data) {
							for (const child of task.data.phases) {
								const childStatus = phaseDocuments.get(
									`${target.taskId}/${child.id}`,
								)?.data.status
								if (childStatus === "dropped") {
									blockers.push({
										kind: "status",
										id: child.id,
										status: childStatus,
										reason: "Child phase is dropped",
									})
								}
								if (childStatus === "open") {
									for (const dependency of child.dependsOn ?? []) {
										const status = phaseDocuments.get(
											`${target.taskId}/${dependency}`,
										)?.data.status
										if (status !== "done") {
											blockers.push({
												kind: "dependency",
												id: `${child.id}:${dependency}`,
												status,
												reason: status
													? `Phase '${child.id}' dependency '${dependency}' is ${status}`
													: `Phase '${child.id}' dependency '${dependency}' is missing`,
											})
										}
									}
								}
							}
						}
					} else if (target.kind === "epic" && epic) {
						aggregateStatuses = epic.data.tasks.flatMap((item: Dependency) => {
							const child = taskDocuments.get(item.id)
							if (!child) return []
							return "phases" in child.data
								? child.data.phases.map(
										(childPhase) =>
											phaseDocuments.get(`${item.id}/${childPhase.id}`)?.data
												.status ?? "open",
									)
								: [child.data.status]
						})
						targetStatus = aggregateProgress(aggregateStatuses).status
						descendantsReady = epic.data.tasks.some((item: Dependency) =>
							taskReady(item.id),
						)
						for (const child of epic.data.tasks) {
							for (const dependency of child.dependsOn ?? []) {
								const status = dependencyStatus(dependency)
								if (status !== "done") {
									blockers.push({
										kind: "dependency",
										id: `${child.id}:${dependency}`,
										status,
										reason: `Task '${child.id}' dependency '${dependency}' is ${status}`,
									})
								}
							}
							const childTask = taskDocuments.get(child.id)
							if (!childTask) continue
							if (!("phases" in childTask.data)) {
								if (childTask.data.status === "dropped") {
									blockers.push({
										kind: "status",
										id: child.id,
										status: "dropped",
										reason: "Child task is dropped",
									})
								}
								continue
							}
							for (const childPhase of childTask.data.phases) {
								const status = phaseDocuments.get(
									`${child.id}/${childPhase.id}`,
								)?.data.status
								if (status === "dropped") {
									blockers.push({
										kind: "status",
										id: `${child.id}/${childPhase.id}`,
										status,
										reason: "Child phase is dropped",
									})
								}
								if (status === "open") {
									for (const dependency of childPhase.dependsOn ?? []) {
										const dependencyState = phaseDocuments.get(
											`${child.id}/${dependency}`,
										)?.data.status
										if (dependencyState !== "done") {
											blockers.push({
												kind: "dependency",
												id: `${child.id}/${childPhase.id}:${dependency}`,
												status: dependencyState,
												reason: dependencyState
													? `Phase '${childPhase.id}' dependency '${dependency}' is ${dependencyState}`
													: `Phase '${childPhase.id}' dependency '${dependency}' is missing`,
											})
										}
									}
								}
							}
						}
					}

					const orchestrationTarget =
						target.kind === "epic" ||
						(target.kind === "task" && task !== null && "phases" in task.data)
					if (!orchestrationTarget && targetStatus !== "open") {
						blockers.push({
							kind: "status",
							id:
								target.phaseId ??
								target.taskId ??
								target.epicId ??
								suppliedTarget,
							status: targetStatus,
							reason: `Target status is ${targetStatus}`,
						})
					}
					for (const issue of validation.issues.filter((item) =>
						relevantPaths.has(item.path),
					)) {
						blockers.push({
							kind: "validation",
							id: issue.path,
							reason: issue.message,
						})
					}
					const ready = orchestrationTarget
						? descendantsReady &&
							!blockers.some((blocker) => blocker.kind === "validation")
						: targetStatus === "open" && blockers.length === 0

					const executionData: ExecutionData | null = phase?.data
						? phase.data
						: task?.data && "repo" in task.data
							? (task.data as ExecutionData)
							: null
					const references: readonly RepositoryReference[] = executionData
						? (executionData.repos ?? [])
						: (epic?.data.repos ?? [])
					const entityDirectory = target.path.replace(
						/\/(?:EPIC|TASK|PHASE)\.md$/,
						"",
					)
					const codePath = join(entityDirectory, "code")
					const inspectionWarnings: string[] = []
					const repositories = new Map(
						(yield* repositoryService.list(root)).map((repository) => [
							repository.alias,
							repository,
						]),
					)

					const inspectCheckout = (
						repositoryPath: string,
						checkoutPath: string,
					) =>
						Effect.gen(function* (): Generator<any, CheckoutInspection, any> {
							const materialized = yield* fs.isDirectory(checkoutPath)
							const listed = yield* runGit(fs, repositoryPath, [
								"worktree",
								"list",
								"--porcelain",
							])
							if (listed === null) {
								inspectionWarnings.push(
									`Unable to inspect worktree registrations for ${repositoryPath}`,
								)
							}
							const listedPaths = worktreePaths(listed)
							const canonicalCheckoutPath = join(
								yield* fs.realPath(root),
								relative(root, checkoutPath),
							)
							let registered =
								listedPaths.has(checkoutPath) ||
								listedPaths.has(canonicalCheckoutPath)
							if (!materialized) {
								return {
									materialized: false,
									registered,
									checkoutCommit: null,
									checkoutBranch: null,
									detached: null,
								}
							}
							const checkoutCommit = yield* runGit(fs, checkoutPath, [
								"rev-parse",
								"HEAD",
							])
							const checkoutBranch = yield* runGit(fs, checkoutPath, [
								"symbolic-ref",
								"--quiet",
								"--short",
								"HEAD",
							])
							const resolvedCheckoutPath = yield* fs.realPath(checkoutPath)
							registered = registered || listedPaths.has(resolvedCheckoutPath)
							if (checkoutCommit === null) {
								inspectionWarnings.push(
									`Unable to inspect checkout ${checkoutPath}`,
								)
							}
							return {
								materialized: true,
								registered,
								checkoutCommit,
								checkoutBranch,
								detached: checkoutBranch === null,
							}
						})

					const writable = executionData
						? yield* Effect.gen(function* () {
								const repository = repositories.get(executionData.repo)
								const repositoryPath =
									repository?.path ?? join(root, "repos", executionData.repo)
								const checkoutPath = join(codePath, executionData.repo)
								const branchCommit = yield* runGit(fs, repositoryPath, [
									"rev-parse",
									`${executionData.branch}^{commit}`,
								])
								const baseCommit = yield* runGit(fs, repositoryPath, [
									"rev-parse",
									`${executionData.base}^{commit}`,
								])
								if (branchCommit === null) {
									inspectionWarnings.push(
										`Unable to resolve branch '${executionData.branch}' in ${repositoryPath}`,
									)
								}
								if (baseCommit === null) {
									inspectionWarnings.push(
										`Unable to resolve base '${executionData.base}' in ${repositoryPath}`,
									)
								}
								return {
									repo: executionData.repo,
									repositoryPath,
									checkoutPath,
									branch: executionData.branch,
									base: executionData.base,
									branchCommit,
									baseCommit,
									...(yield* inspectCheckout(repositoryPath, checkoutPath)),
								}
							})
						: null

					const referenceCheckouts: ReferenceCheckout[] = []
					for (const reference of references) {
						const repository = repositories.get(reference.repo)
						const repositoryPath =
							repository?.path ?? join(root, "repos", reference.repo)
						const checkoutPath = join(codePath, reference.repo)
						const resolvedCommit = yield* runGit(fs, repositoryPath, [
							"rev-parse",
							`${reference.ref}^{commit}`,
						])
						if (resolvedCommit === null) {
							inspectionWarnings.push(
								`Unable to resolve reference '${reference.ref}' in ${repositoryPath}`,
							)
						}
						referenceCheckouts.push({
							repo: reference.repo,
							ref: reference.ref,
							repositoryPath,
							checkoutPath,
							resolvedCommit,
							...(yield* inspectCheckout(repositoryPath, checkoutPath)),
						})
					}

					const checkoutStates = [writable, ...referenceCheckouts].filter(
						(value): value is NonNullable<typeof value> => value !== null,
					)
					const materializedCount = checkoutStates.filter(
						(value) => value.materialized,
					).length
					const materialization =
						checkoutStates.length === 0 || materializedCount === 0
							? "absent"
							: materializedCount === checkoutStates.length
								? "complete"
								: "partial"

					const projectDocument = <T>(document: Document<T> | null) =>
						document
							? options.compact
								? {
										id: document.id,
										path: document.path,
										sha256: document.sha256,
										data: document.data,
									}
								: document
							: null

					return {
						projection: options.compact ? "compact" : "complete",
						workbase: {
							root,
							configPath: join(root, "agency.json"),
							version: config.version,
						},
						target,
						documents: {
							epic: projectDocument(epic),
							task: projectDocument(task),
							phase: projectDocument(phase),
						},
						graph: {
							parent:
								target.kind === "phase"
									? { kind: "task", id: target.taskId }
									: target.kind === "task" && epicId
										? { kind: "epic", id: epicId }
										: null,
							dependencies,
							dependents,
							readiness: {
								...readinessState(targetStatus, blockers, ready),
								blockers,
							},
							aggregate: aggregateProgress(aggregateStatuses),
						},
						authority: {
							mode: executionData ? "execution" : "orchestration",
							writable: writable
								? {
										repo: writable.repo,
										repositoryPath: writable.repositoryPath,
										checkoutPath: writable.checkoutPath,
										branch: writable.branch,
										base: writable.base,
									}
								: null,
							references: referenceCheckouts.map((reference) => ({
								repo: reference.repo,
								ref: reference.ref,
								repositoryPath: reference.repositoryPath,
								checkoutPath: reference.checkoutPath,
							})),
						},
						workspace: options.compact
							? {
									codePath,
									materialization,
									writable: writable
										? {
												materialized: writable.materialized,
												registered: writable.registered,
											}
										: null,
									references: referenceCheckouts.map((reference) => ({
										repo: reference.repo,
										materialized: reference.materialized,
										registered: reference.registered,
									})),
									warnings: inspectionWarnings,
								}
							: {
									codePath,
									materialization,
									writable,
									references: referenceCheckouts,
									warnings: inspectionWarnings,
								},
						pr: executionData?.pr
							? normalizePullRequestRecord(executionData.pr)
							: { url: null, state: "none" },
						validation: {
							valid: validation.valid,
							warnings: validation.issues,
						},
					}
				}),
		}),
	},
) {}
