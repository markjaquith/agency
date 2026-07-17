import { Schema, TreeFormatter } from "@effect/schema"
import { Data, Effect, Either } from "effect"
import { join, relative } from "node:path"
import {
	GRAPH_VERSION,
	type AgencyGraph,
	type GraphBlocker,
	type GraphEdge,
	type GraphExecutionGit,
	type GraphExecutionWorkspace,
	type GraphInclude,
	type GraphNode,
	type GraphNodeKind,
	type GraphPr,
	type GraphProgress,
	type GraphRepositoryGit,
} from "../graph-schema"
import { parseFrontmatter } from "../workbase/frontmatter"
import {
	EpicFrontmatter,
	PhaseFrontmatter,
	TaskFrontmatter,
	type Dependency,
	type EpicFrontmatter as EpicData,
	type PhaseFrontmatter as PhaseData,
	type TaskFrontmatter as TaskData,
	type WorkStatus,
} from "../workbase/schemas"
import { FileSystemService } from "./FileSystemService"
import { WorkbaseService } from "./WorkbaseService"

class GraphError extends Data.TaggedError("GraphError")<{
	readonly message: string
	readonly path?: string
}> {}

interface Document<T> {
	readonly id: string
	readonly path: string
	readonly sha256: string
	readonly data: T
	readonly body: string
}

interface RepositoryRecord {
	readonly alias: string
	readonly path: string
	readonly target: string | null
}

type ExecutionData = PhaseData | Extract<TaskData, { readonly repo: string }>

export interface GraphOptions {
	readonly cwd?: string
	readonly ready?: boolean
	readonly blocked?: boolean
	readonly statuses?: readonly WorkStatus[]
	readonly repositories?: readonly string[]
	readonly kinds?: readonly GraphNodeKind[]
	readonly include?: readonly GraphInclude[]
}

const epicNodeId = (id: string) => `epic:${id}`
const taskNodeId = (id: string) => `task:${id}`
const phaseNodeId = (taskId: string, phaseId: string) =>
	`phase:${taskId}/${phaseId}`
const repositoryNodeId = (alias: string) => `repository:${alias}`
const taskExecutionNodeId = (taskId: string) => `execution-unit:task/${taskId}`
const phaseExecutionNodeId = (taskId: string, phaseId: string) =>
	`execution-unit:phase/${taskId}/${phaseId}`

const progress = (statuses: readonly WorkStatus[]): GraphProgress => {
	const counts = {
		total: statuses.length,
		open: statuses.filter((status) => status === "open").length,
		working: statuses.filter((status) => status === "working").length,
		delegated: statuses.filter((status) => status === "delegated").length,
		done: statuses.filter((status) => status === "done").length,
		dropped: statuses.filter((status) => status === "dropped").length,
		terminal: statuses.filter(
			(status) => status === "done" || status === "dropped",
		).length,
	}
	const status: WorkStatus =
		statuses.length === 0
			? "open"
			: statuses.every((value) => value === "done")
				? "done"
				: statuses.every((value) => value === "done" || value === "dropped")
					? "dropped"
					: statuses.includes("working")
						? "working"
						: statuses.includes("delegated")
							? "delegated"
							: "open"
	return { status, ...counts }
}

const hash = (content: string) =>
	new Bun.CryptoHasher("sha256").update(content).digest("hex")

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

const run = (fs: FileSystemService, args: readonly string[], cwd?: string) =>
	fs.runCommand(args, { cwd, captureOutput: true }).pipe(
		Effect.map((result) =>
			result.exitCode === 0 ? result.stdout.trim() || null : null,
		),
		Effect.catchAll(() => Effect.succeed(null)),
	)

const runText = (
	fs: FileSystemService,
	args: readonly string[],
	cwd?: string,
) =>
	fs.runCommand(args, { cwd, captureOutput: true }).pipe(
		Effect.map((result) =>
			result.exitCode === 0 ? result.stdout.trim() : null,
		),
		Effect.catchAll(() => Effect.succeed(null)),
	)

const edge = (
	kind: GraphEdge["kind"],
	from: string,
	to: string,
): GraphEdge => ({ id: `${kind}:${from}->${to}`, kind, from, to })

export class GraphService extends Effect.Service<GraphService>()(
	"GraphService",
	{
		sync: () => ({
			get: (options: GraphOptions = {}) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const workbase = yield* WorkbaseService
					const { root, config } = yield* workbase.loadConfig(options.cwd)
					const includes = [...new Set(options.include ?? [])].sort()
					const include = new Set(includes)
					const epics = new Map<string, Document<EpicData>>()
					const tasks = new Map<string, Document<TaskData>>()
					const phases = new Map<string, Document<PhaseData>>()

					const directories = (path: string) =>
						Effect.gen(function* () {
							if (!(yield* fs.isDirectory(path))) return []
							return (yield* fs.readDirectory(path))
								.filter((entry) => entry.isDirectory)
								.map((entry) => entry.name)
								.sort()
						})

					const readDocument = <S extends Schema.Schema.AnyNoContext>(
						id: string,
						path: string,
						schema: S,
					) =>
						Effect.gen(function* () {
							const content = yield* fs.readFile(path)
							const parsed = yield* parseFrontmatter(content, path).pipe(
								Effect.mapError(
									(error) => new GraphError({ path, message: error.message }),
								),
							)
							const decoded = decode(schema, parsed.data)
							if (!decoded.ok) {
								return yield* new GraphError({
									path,
									message: `Invalid graph document ${path}:\n${decoded.error}`,
								})
							}
							return {
								id,
								path,
								sha256: hash(content),
								data: decoded.value,
								body: parsed.body,
							} satisfies Document<Schema.Schema.Type<S>>
						})

					for (const id of yield* directories(join(root, "epics"))) {
						const path = join(root, "epics", id, "EPIC.md")
						if (yield* fs.exists(path)) {
							epics.set(id, yield* readDocument(id, path, EpicFrontmatter))
						}
					}
					for (const id of yield* directories(join(root, "tasks"))) {
						const path = join(root, "tasks", id, "TASK.md")
						if (yield* fs.exists(path)) {
							tasks.set(id, yield* readDocument(id, path, TaskFrontmatter))
						}
						for (const phaseId of yield* directories(
							join(root, "tasks", id, "phases"),
						)) {
							const phasePath = join(
								root,
								"tasks",
								id,
								"phases",
								phaseId,
								"PHASE.md",
							)
							if (yield* fs.exists(phasePath)) {
								phases.set(
									`${id}/${phaseId}`,
									yield* readDocument(phaseId, phasePath, PhaseFrontmatter),
								)
							}
						}
					}

					const repositoryRecords: RepositoryRecord[] = []
					const reposPath = join(root, "repos")
					if (yield* fs.isDirectory(reposPath)) {
						for (const entry of (yield* fs.readDirectory(reposPath))
							.filter((item) => item.isDirectory || item.isSymlink)
							.sort((a, b) => a.name.localeCompare(b.name))) {
							repositoryRecords.push({
								alias: entry.name,
								path: join(reposPath, entry.name),
								target: entry.isSymlink
									? yield* fs.readSymlinkTarget(join(reposPath, entry.name))
									: null,
							})
						}
					}

					const taskDeclarations = new Map<string, Dependency>()
					for (const epic of epics.values()) {
						for (const declaration of epic.data.tasks) {
							taskDeclarations.set(declaration.id, declaration)
						}
					}
					const taskDependencies = (taskId: string) =>
						taskDeclarations.get(taskId)?.dependsOn ?? []
					const taskLeafStatuses = (taskId: string): WorkStatus[] => {
						const task = tasks.get(taskId)
						if (!task) return []
						return "phases" in task.data
							? task.data.phases.map(
									(item) =>
										phases.get(`${taskId}/${item.id}`)?.data.status ?? "open",
								)
							: [task.data.status]
					}
					const taskStatus = (taskId: string) =>
						progress(taskLeafStatuses(taskId)).status
					const dependencyBlockers = (
						dependencies: readonly string[],
						toId: (id: string) => string,
						status: (id: string) => WorkStatus | undefined,
						label: string,
					): GraphBlocker[] =>
						dependencies.flatMap((dependency) => {
							const value = status(dependency)
							return value === "done"
								? []
								: [
										{
											kind: "dependency" as const,
											id: toId(dependency),
											...(value ? { status: value } : {}),
											reason: value
												? `${label} dependency is ${value}`
												: `${label} dependency is missing`,
										},
									]
						})

					const validation = yield* workbase.validate(root)
					const validationBlockers = (
						paths: readonly string[],
					): GraphBlocker[] =>
						validation.issues
							.filter((issue) => paths.includes(issue.path))
							.map((issue) => ({
								kind: "validation" as const,
								id: issue.path,
								reason: issue.message,
							}))
					const uniqueBlockers = (blockers: readonly GraphBlocker[]) => [
						...new Map(
							blockers.map((item) => [
								`${item.kind}:${item.id}:${item.reason}`,
								item,
							]),
						).values(),
					]

					const phaseState = (taskId: string, phaseId: string) => {
						const task = tasks.get(taskId)
						const phase = phases.get(`${taskId}/${phaseId}`)
						const declaration =
							task && "phases" in task.data
								? task.data.phases.find((item) => item.id === phaseId)
								: undefined
						const blockers = [
							...dependencyBlockers(
								declaration?.dependsOn ?? [],
								(id) => phaseNodeId(taskId, id),
								(id) => phases.get(`${taskId}/${id}`)?.data.status,
								"Phase",
							),
							...dependencyBlockers(
								taskDependencies(taskId),
								taskNodeId,
								(id) => (tasks.has(id) ? taskStatus(id) : undefined),
								"Parent task",
							),
							...validationBlockers(
								[phase?.path, task?.path]
									.filter((path): path is string => Boolean(path))
									.map((path) => relative(root, path)),
							),
						]
						const status = phase?.data.status ?? "open"
						if (status !== "open") {
							blockers.push({
								kind: "status",
								id: phaseNodeId(taskId, phaseId),
								status,
								reason: `Phase status is ${status}`,
							})
						}
						return {
							status,
							aggregate: progress([status]),
							readiness: {
								ready: status === "open" && blockers.length === 0,
								blocked: status === "open" && blockers.length > 0,
								blockers: uniqueBlockers(blockers),
							},
						}
					}

					const taskState = (taskId: string) => {
						const task = tasks.get(taskId)
						const statuses = taskLeafStatuses(taskId)
						const aggregate = progress(statuses)
						const descendantPaths = task
							? [
									relative(root, task.path),
									...[...phases.entries()]
										.filter(([key]) => key.startsWith(`${taskId}/`))
										.map(([, phase]) => relative(root, phase.path)),
								]
							: []
						const blockers = [
							...dependencyBlockers(
								taskDependencies(taskId),
								taskNodeId,
								(id) => (tasks.has(id) ? taskStatus(id) : undefined),
								"Task",
							),
							...validationBlockers(descendantPaths),
						]
						let ready = false
						if (task && "phases" in task.data) {
							ready =
								blockers.every((item) => item.kind !== "validation") &&
								taskDependencies(taskId).every(
									(id) => taskStatus(id) === "done",
								) &&
								task.data.phases.some(
									(item) => phaseState(taskId, item.id).readiness.ready,
								)
							for (const item of task.data.phases) {
								const state = phaseState(taskId, item.id)
								blockers.push(
									...state.readiness.blockers.filter(
										(blocker) =>
											blocker.kind === "dependency" ||
											blocker.kind === "validation",
									),
								)
								if (state.status === "dropped") {
									blockers.push({
										kind: "status",
										id: phaseNodeId(taskId, item.id),
										status: "dropped",
										reason: "Child phase is dropped",
									})
								}
							}
						} else if (task && "status" in task.data) {
							ready = task.data.status === "open" && blockers.length === 0
							if (task.data.status !== "open") {
								blockers.push({
									kind: "status",
									id: taskNodeId(taskId),
									status: task.data.status,
									reason: `Task status is ${task.data.status}`,
								})
							}
						}
						const taskBlockers = uniqueBlockers(blockers)
						return {
							status: aggregate.status,
							aggregate,
							readiness: {
								ready,
								blocked: !ready && taskBlockers.length > 0,
								blockers: taskBlockers,
							},
						}
					}

					const epicState = (epicId: string) => {
						const epic = epics.get(epicId)
						const statuses =
							epic?.data.tasks.flatMap((item) => taskLeafStatuses(item.id)) ??
							[]
						const aggregate = progress(statuses)
						const paths = epic
							? [
									relative(root, epic.path),
									...epic.data.tasks.flatMap((item) => {
										const task = tasks.get(item.id)
										return [
											...(task ? [relative(root, task.path)] : []),
											...[...phases.entries()]
												.filter(([key]) => key.startsWith(`${item.id}/`))
												.map(([, phase]) => relative(root, phase.path)),
										]
									}),
								]
							: []
						const blockers = validationBlockers(paths)
						for (const item of epic?.data.tasks ?? []) {
							const childState = taskState(item.id)
							blockers.push(
								...childState.readiness.blockers.filter(
									(blocker) =>
										blocker.kind !== "status" || blocker.status === "dropped",
								),
							)
							if (taskStatus(item.id) === "dropped") {
								blockers.push({
									kind: "status",
									id: taskNodeId(item.id),
									status: "dropped",
									reason: "Child task is dropped",
								})
							}
						}
						const ready =
							!blockers.some((item) => item.kind === "validation") &&
							Boolean(
								epic?.data.tasks.some(
									(item) => taskState(item.id).readiness.ready,
								),
							)
						const epicBlockers = uniqueBlockers(blockers)
						return {
							status: aggregate.status,
							aggregate,
							readiness: {
								ready,
								blocked: !ready && epicBlockers.length > 0,
								blockers: epicBlockers,
							},
						}
					}

					const edges: GraphEdge[] = []
					for (const epic of epics.values()) {
						for (const item of epic.data.tasks) {
							edges.push(edge("owns", epicNodeId(epic.id), taskNodeId(item.id)))
							for (const dependency of item.dependsOn ?? []) {
								edges.push(
									edge(
										"depends_on",
										taskNodeId(item.id),
										taskNodeId(dependency),
									),
								)
							}
						}
					}
					for (const task of tasks.values()) {
						if ("phases" in task.data) {
							for (const item of task.data.phases) {
								edges.push(
									edge(
										"owns",
										taskNodeId(task.id),
										phaseNodeId(task.id, item.id),
									),
								)
								for (const dependency of item.dependsOn ?? []) {
									edges.push(
										edge(
											"depends_on",
											phaseNodeId(task.id, item.id),
											phaseNodeId(task.id, dependency),
										),
									)
								}
							}
						} else {
							edges.push(
								edge("owns", taskNodeId(task.id), taskExecutionNodeId(task.id)),
							)
						}
					}
					for (const [key, phase] of phases) {
						const taskId = key.slice(0, key.indexOf("/"))
						edges.push(
							edge(
								"owns",
								phaseNodeId(taskId, phase.id),
								phaseExecutionNodeId(taskId, phase.id),
							),
						)
					}

					const executionRepositories = (
						data: TaskData | PhaseData,
					): readonly string[] =>
						"repo" in data
							? [data.repo, ...(data.repos ?? []).map((item) => item.repo)]
							: []
					const executionEdges = (id: string, data: TaskData | PhaseData) => {
						if (!("repo" in data)) return
						edges.push(edge("writes", id, repositoryNodeId(data.repo)))
						for (const reference of data.repos ?? []) {
							edges.push(
								edge("references", id, repositoryNodeId(reference.repo)),
							)
						}
					}
					for (const epic of epics.values()) {
						for (const reference of epic.data.repos) {
							edges.push(
								edge(
									"references",
									epicNodeId(epic.id),
									repositoryNodeId(reference.repo),
								),
							)
						}
					}
					for (const task of tasks.values()) {
						if (!("phases" in task.data)) {
							executionEdges(taskExecutionNodeId(task.id), task.data)
						}
					}
					for (const [key, phase] of phases) {
						const taskId = key.slice(0, key.indexOf("/"))
						executionEdges(phaseExecutionNodeId(taskId, phase.id), phase.data)
					}

					const reverseDependencies = new Map<string, string[]>()
					for (const item of edges.filter(
						(value) => value.kind === "depends_on",
					)) {
						const dependents = reverseDependencies.get(item.to) ?? []
						dependents.push(item.from)
						reverseDependencies.set(item.to, dependents)
					}
					const dependents = (id: string) =>
						[...(reverseDependencies.get(id) ?? [])].sort()

					const documentDetails = <T extends Record<string, unknown>>(
						document: Document<T>,
					) => ({
						data: { ...document.data, sha256: document.sha256 },
						...(include.has("bodies") ? { body: document.body } : {}),
						...(include.has("workspace")
							? {
									workspace: {
										documentPath: document.path,
										directory: document.path.replace(
											/\/(?:EPIC|TASK|PHASE)\.md$/,
											"",
										),
									},
								}
							: {}),
					})

					const inspectGit = (path: string) =>
						Effect.gen(function* () {
							const bare = yield* run(fs, [
								"git",
								"-C",
								path,
								"rev-parse",
								"--is-bare-repository",
							])
							return {
								kind:
									bare === null
										? null
										: bare === "true"
											? "bare"
											: "repository",
								remote: yield* run(fs, [
									"git",
									"-C",
									path,
									"remote",
									"get-url",
									"origin",
								]),
								head: yield* run(fs, ["git", "-C", path, "rev-parse", "HEAD"]),
								branch: yield* run(fs, [
									"git",
									"-C",
									path,
									"symbolic-ref",
									"--quiet",
									"--short",
									"HEAD",
								]),
							} satisfies GraphRepositoryGit
						})

					const executionDetails = (entityPath: string, data: ExecutionData) =>
						Effect.gen(function* () {
							const directory = entityPath.replace(/\/(?:TASK|PHASE)\.md$/, "")
							const checkoutPath = join(directory, "code", data.repo)
							const repositoryPath = join(root, "repos", data.repo)
							const materialized = yield* fs.isDirectory(checkoutPath)
							const result: {
								workspace?: GraphExecutionWorkspace
								git?: GraphExecutionGit
								pr?: GraphPr
							} = {}
							if (include.has("workspace")) {
								result.workspace = {
									codePath: join(directory, "code"),
									checkoutPath,
									materialized,
								}
							}
							if (include.has("git")) {
								result.git = {
									branch: data.branch,
									base: data.base,
									branchCommit: yield* run(fs, [
										"git",
										"-C",
										repositoryPath,
										"rev-parse",
										`${data.branch}^{commit}`,
									]),
									baseCommit: yield* run(fs, [
										"git",
										"-C",
										repositoryPath,
										"rev-parse",
										`${data.base}^{commit}`,
									]),
									checkoutCommit: materialized
										? yield* run(fs, [
												"git",
												"-C",
												checkoutPath,
												"rev-parse",
												"HEAD",
											])
										: null,
									checkoutBranch: materialized
										? yield* run(fs, [
												"git",
												"-C",
												checkoutPath,
												"symbolic-ref",
												"--quiet",
												"--short",
												"HEAD",
											])
										: null,
									dirty: materialized
										? ((status) =>
												status === null ? null : status.length > 0)(
												yield* runText(fs, [
													"git",
													"-C",
													checkoutPath,
													"status",
													"--porcelain",
												]),
											)
										: null,
								}
							}
							if (include.has("pr")) {
								if (!data.pr) {
									result.pr = { url: null, state: "none" }
								} else {
									const detail = yield* run(fs, [
										"gh",
										"pr",
										"view",
										data.pr,
										"--json",
										"number,state,title,isDraft,headRefName,baseRefName,url",
									])
									result.pr = detail
										? { ...JSON.parse(detail), recordedUrl: data.pr }
										: { url: data.pr, state: "unavailable" }
								}
							}
							return result
						})

					const nodes: GraphNode[] = []
					for (const epic of epics.values()) {
						const state = epicState(epic.id)
						nodes.push({
							id: epicNodeId(epic.id),
							kind: "epic",
							key: epic.id,
							...state,
							dependents: dependents(epicNodeId(epic.id)),
							repositories: epic.data.repos.map((item) => item.repo).sort(),
							...documentDetails(epic),
						})
					}
					for (const task of tasks.values()) {
						const state = taskState(task.id)
						const repositories =
							"phases" in task.data
								? [
										...new Set(
											task.data.phases.flatMap((item) => {
												const phase = phases.get(`${task.id}/${item.id}`)
												return phase ? executionRepositories(phase.data) : []
											}),
										),
									].sort()
								: [...executionRepositories(task.data)].sort()
						nodes.push({
							id: taskNodeId(task.id),
							kind: "task",
							key: task.id,
							...state,
							dependents: dependents(taskNodeId(task.id)),
							repositories,
							...documentDetails(task),
						})
						if (!("phases" in task.data)) {
							nodes.push({
								id: taskExecutionNodeId(task.id),
								kind: "execution-unit",
								key: `task/${task.id}`,
								...state,
								dependents: dependents(taskNodeId(task.id)),
								repositories,
								data: { taskId: task.id, ...task.data },
								...(yield* executionDetails(task.path, task.data)),
							})
						}
					}
					for (const [key, phase] of phases) {
						const taskId = key.slice(0, key.indexOf("/"))
						const state = phaseState(taskId, phase.id)
						const repositories = [...executionRepositories(phase.data)].sort()
						nodes.push({
							id: phaseNodeId(taskId, phase.id),
							kind: "phase",
							key,
							...state,
							dependents: dependents(phaseNodeId(taskId, phase.id)),
							repositories,
							...documentDetails(phase),
						})
						nodes.push({
							id: phaseExecutionNodeId(taskId, phase.id),
							kind: "execution-unit",
							key: `phase/${key}`,
							...state,
							dependents: dependents(phaseNodeId(taskId, phase.id)),
							repositories,
							data: { taskId, phaseId: phase.id, ...phase.data },
							...(yield* executionDetails(phase.path, phase.data)),
						})
					}
					for (const repository of repositoryRecords) {
						nodes.push({
							id: repositoryNodeId(repository.alias),
							kind: "repository",
							key: repository.alias,
							status: null,
							readiness: null,
							aggregate: null,
							dependents: [],
							repositories: [repository.alias],
							data: { alias: repository.alias },
							...(include.has("workspace")
								? {
										workspace: {
											path: repository.path,
											target: repository.target,
										},
									}
								: {}),
							...(include.has("git")
								? { git: yield* inspectGit(repository.path) }
								: {}),
						})
					}

					const filters = {
						ready: options.ready ?? null,
						blocked: options.blocked ?? null,
						statuses: [...(options.statuses ?? [])].sort(),
						repositories: [...(options.repositories ?? [])].sort(),
						kinds: [...(options.kinds ?? [])].sort(),
					}
					const filteredNodes = nodes
						.filter(
							(node) =>
								options.ready === undefined ||
								node.readiness?.ready === options.ready,
						)
						.filter(
							(node) =>
								options.blocked === undefined ||
								node.readiness?.blocked === options.blocked,
						)
						.filter(
							(node) =>
								!options.statuses?.length ||
								(node.status !== null &&
									options.statuses.includes(node.status)),
						)
						.filter(
							(node) =>
								!options.repositories?.length ||
								node.repositories.some((alias) =>
									options.repositories!.includes(alias),
								),
						)
						.filter(
							(node) =>
								!options.kinds?.length || options.kinds.includes(node.kind),
						)
						.sort((a, b) => a.id.localeCompare(b.id))
					const nodeIds = new Set(filteredNodes.map((node) => node.id))
					const filteredEdges = edges
						.filter((item) => nodeIds.has(item.from) && nodeIds.has(item.to))
						.sort((a, b) => a.id.localeCompare(b.id))
					const leafStatuses = [
						...tasks
							.values()
							.flatMap((task) =>
								"phases" in task.data ? [] : [task.data.status],
							),
						...phases.values().map((phase) => phase.data.status),
					]

					return {
						version: GRAPH_VERSION,
						workbase: {
							version: config.version,
							...(include.has("workspace") ? { root } : {}),
						},
						filters,
						includes,
						nodes: filteredNodes,
						edges: filteredEdges,
						summary: progress(leafStatuses),
						validation: {
							valid: validation.valid,
							issues: validation.issues,
						},
					} satisfies AgencyGraph
				}),
		}),
	},
) {}
