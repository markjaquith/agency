import { Context, Effect, Layer, Option, Schema } from "effect"
import { join, relative } from "node:path"
import {
	actActions,
	actionOutput,
	type ActEntity,
} from "../commands/act-actions"
import type { GraphNode } from "../graph-schema"
import {
	attentionSignals,
	isReadyToMerge,
	type AttentionPullRequest,
	type AttentionSnapshot,
	type AttentionUnit,
	type AttentionWorkbase,
	type CatalogAction,
} from "../workbase/attention"
import {
	archivedPhaseDirectory,
	archivedTaskDirectory,
} from "../workbase/archive"
import { normalizePullRequestRecord } from "../workbase/delivery-command"
import { documentRevision } from "../workbase/document-revision"
import { parseFrontmatterSync } from "../workbase/frontmatter"
import type { RuntimePane, RuntimeSnapshot } from "../workbase/runtime"
import {
	executionUnitPaths,
	reconcileRuntime,
	type RuntimeBinding,
	type RuntimeUnit,
} from "../workbase/runtime-bindings"
import {
	PullRequestRecord,
	WorkStatus,
	type WorkbaseConfig,
} from "../workbase/schemas"
import {
	ATTENTION_VERSION,
	type AttentionReport,
	type AttentionWorkbaseRef,
} from "../attention-schema"
import { FileSystemService } from "./FileSystemService"
import { GraphService } from "./GraphService"
import { PullRequestStatusService } from "./PullRequestStatusService"
import { RuntimeBindingService } from "./RuntimeBindingService"
import { RuntimeService } from "./RuntimeService"
import { TicketService } from "./TicketService"
import { WorkbaseService } from "./WorkbaseService"

const PR_CONCURRENCY = 8
const WORKBASE_CONCURRENCY = 4
const DEFAULT_JIRA = { doneStatus: "Done", reopenStatus: "In Progress" }

type WorkbaseSource = AttentionWorkbase["source"]

interface SupervisionOptions {
	/** Restrict supervision to one registered workbase ID, name, or path. */
	readonly workbase?: string
	/** Also inspect every archived execution unit, not only bound ones. */
	readonly archived?: boolean
	readonly cwd?: string
	readonly configDirectory?: string
	readonly env?: NodeJS.ProcessEnv
}

interface UnitSeed {
	readonly id: string
	readonly kind: "task" | "phase"
	readonly taskId: string
	readonly phaseId?: string
	readonly path: string
	readonly archived: boolean
	readonly status: WorkStatus
	readonly revision: string | null
	readonly repo: string
	readonly pr: unknown
	readonly ticketUrl: string | null
	readonly directories: readonly string[]
	readonly entity: ActEntity | null
	readonly parent: AttentionUnit["parent"]
	readonly review: boolean
}

const ArchivedDocument = Schema.Struct({
	status: Schema.optional(WorkStatus),
	ticketUrl: Schema.optional(Schema.NullOr(Schema.String)),
	repo: Schema.optional(Schema.String),
	review: Schema.optional(Schema.Struct({ repo: Schema.String })),
	pr: Schema.optional(
		Schema.NullOr(Schema.Union([Schema.String, PullRequestRecord])),
	),
	phases: Schema.optional(Schema.Array(Schema.Unknown)),
})
type ArchivedDocument = Schema.Schema.Type<typeof ArchivedDocument>
const decodeArchived = Schema.decodeUnknownOption(ArchivedDocument)

const parseUnitId = (
	unit: string,
): { readonly taskId: string; readonly phaseId?: string } | null => {
	const task = unit.match(/^execution-unit:task\/([^/]+)$/)
	if (task) return { taskId: task[1]! }
	const phase = unit.match(/^execution-unit:phase\/([^/]+)\/([^/]+)$/)
	return phase ? { taskId: phase[1]!, phaseId: phase[2]! } : null
}

const message = (error: unknown) =>
	error instanceof Error
		? error.message
		: typeof error === "object" &&
			  error !== null &&
			  "message" in error &&
			  typeof error.message === "string"
			? error.message
			: String(error)

const catalog = (
	nodes: readonly GraphNode[],
	root: string,
	node?: ActEntity,
): CatalogAction[] =>
	actActions(nodes, { cwd: root, auto: true, silent: true }, undefined, node)
		.map((action) => actionOutput(action, true))
		.map((output) => ({
			id: output.id,
			label: output.label,
			available: output.available,
			blockedReason: output.blockedReason,
			command: output.command ?? null,
			commandTemplate: output.commandTemplate ?? null,
			inputs: output.inputs ?? [],
		}))

export class SupervisionService extends Context.Service<SupervisionService>()(
	"SupervisionService",
	{
		make: Effect.sync(() => {
			const readArchived = (path: string) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const content = yield* fs
						.readFile(path)
						.pipe(Effect.orElseSucceed(() => null))
					if (content === null) return null
					try {
						const decoded = decodeArchived(
							parseFrontmatterSync(content, path).data,
						)
						return Option.isSome(decoded)
							? { data: decoded.value, revision: documentRevision(content) }
							: null
					} catch {
						return null
					}
				})

			const archivedUnits = (
				root: string,
				selectors: readonly {
					readonly taskId: string
					readonly phaseId?: string
				}[],
			) =>
				Effect.gen(function* () {
					const units: UnitSeed[] = []
					const tasks = new Map<string, ArchivedDocument | null>()
					for (const selector of selectors) {
						const taskDirectory = archivedTaskDirectory(root, selector.taskId)
						if (!tasks.has(selector.taskId)) {
							tasks.set(
								selector.taskId,
								(yield* readArchived(join(taskDirectory, "TASK.md")))?.data ??
									null,
							)
						}
						const task = tasks.get(selector.taskId)
						if (!task) continue
						const directory = selector.phaseId
							? archivedPhaseDirectory(root, selector.taskId, selector.phaseId)
							: taskDirectory
						const path = join(
							directory,
							selector.phaseId ? "PHASE.md" : "TASK.md",
						)
						const document = selector.phaseId
							? yield* readArchived(path)
							: { data: task, revision: null }
						if (!document || (!selector.phaseId && task.phases)) continue
						const data = document.data
						const original = executionUnitPaths(root, selector, "")
						units.push({
							id: selector.phaseId
								? `execution-unit:phase/${selector.taskId}/${selector.phaseId}`
								: `execution-unit:task/${selector.taskId}`,
							kind: selector.phaseId ? "phase" : "task",
							taskId: selector.taskId,
							...(selector.phaseId ? { phaseId: selector.phaseId } : {}),
							path,
							archived: true,
							status: data.status ?? "open",
							revision: document.revision,
							repo: data.review?.repo ?? data.repo ?? "",
							pr: data.review ? null : (data.pr ?? null),
							review: data.review !== undefined,
							ticketUrl: task.ticketUrl ?? null,
							directories: [directory, original.directory],
							entity: null,
							parent: selector.phaseId
								? { path: join(taskDirectory, "TASK.md"), revision: null }
								: null,
						})
					}
					return units
				})

			const listArchived = (root: string) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const entries = yield* fs
						.readDirectory(join(root, "archive", "tasks"))
						.pipe(Effect.orElseSucceed(() => []))
					const selectors: { taskId: string; phaseId?: string }[] = []
					for (const entry of entries) {
						if (!entry.isDirectory) continue
						selectors.push({ taskId: entry.name })
						const phases = yield* fs
							.readDirectory(
								join(archivedTaskDirectory(root, entry.name), "phases"),
							)
							.pipe(Effect.orElseSucceed(() => []))
						for (const phase of phases) {
							if (phase.isDirectory)
								selectors.push({ taskId: entry.name, phaseId: phase.name })
						}
					}
					return selectors
				})

			const pullRequest = (
				raw: unknown,
				config: WorkbaseConfig,
				archived: boolean,
			): Effect.Effect<
				AttentionPullRequest | null,
				never,
				PullRequestStatusService | FileSystemService
			> =>
				Effect.gen(function* () {
					if (!raw) return null
					let record: PullRequestRecord
					try {
						record = normalizePullRequestRecord(
							raw as PullRequestRecord | string,
						)
					} catch {
						return null
					}
					const repository = record.baseRepository ?? record.repository
					const base = {
						url: record.url,
						repository,
						recordedState: record.state,
						live: null,
						mergeCommand: null,
					} satisfies AttentionPullRequest
					if (
						config.delivery ||
						record.provider !== "github" ||
						record.state === "merged" ||
						(archived && record.state === "closed")
					)
						return base
					const service = yield* PullRequestStatusService
					const live = yield* service.read(record.url)
					const mergeCommand =
						isReadyToMerge(live) && live.state === "available" && live.headSha
							? [
									"gh",
									"pr",
									"merge",
									record.url,
									`--${yield* service.mergeMethod(repository)}`,
									"--match-head-commit",
									live.headSha,
								]
							: null
					return { ...base, live, mergeCommand }
				})

			const inspectWorkbase = (
				ref: AttentionWorkbaseRef,
				source: WorkbaseSource,
				isDefault: boolean,
				snapshot: RuntimeSnapshot | null,
				options: SupervisionOptions,
			) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const workbases = yield* WorkbaseService
					const graphs = yield* GraphService
					const bindingService = yield* RuntimeBindingService
					const tickets = yield* TicketService
					const loadedConfig = yield* workbases.loadConfig(ref.root)
					const root = loadedConfig.root
					const graph = yield* graphs.get({
						loadedConfig,
						include: ["pr"],
					})
					const entities = new Map(
						graph.nodes.flatMap((node) =>
							node.kind === "task" || node.kind === "phase"
								? [[node.id, node as ActEntity] as const]
								: [],
						),
					)
					const active: UnitSeed[] = graph.nodes.flatMap((node) => {
						if (node.kind !== "execution-unit") return []
						const phaseId =
							"phaseId" in node.data ? node.data.phaseId : undefined
						const taskId = node.data.taskId
						const entity =
							entities.get(
								phaseId ? `phase:${taskId}/${phaseId}` : `task:${taskId}`,
							) ?? null
						const paths = executionUnitPaths(root, { taskId, phaseId }, "")
						return [
							{
								id: node.id,
								kind: phaseId ? "phase" : "task",
								taskId,
								...(phaseId ? { phaseId } : {}),
								path: join(paths.directory, phaseId ? "PHASE.md" : "TASK.md"),
								archived: false,
								status: node.status,
								revision: entity?.data.sha256 ?? null,
								repo:
									"review" in node.data
										? node.data.review.repo
										: node.data.repo,
								pr: "review" in node.data ? null : node.data.pr,
								review: "review" in node.data,
								ticketUrl:
									(phaseId
										? (() => {
												const task = entities.get(`task:${taskId}`)
												return task && "ticketUrl" in task.data
													? task.data.ticketUrl
													: null
											})()
										: node.data.ticketUrl) ?? null,
								directories: [paths.directory],
								entity,
								parent: phaseId
									? {
											path: join(root, "tasks", taskId, "TASK.md"),
											revision:
												entities.get(`task:${taskId}`)?.data.sha256 ?? null,
										}
									: null,
							} satisfies UnitSeed,
						]
					})
					const bindings: RuntimeBinding[] = yield* bindingService.list(
						root,
						options.env,
					)
					const canonical = yield* fs
						.realPath(root)
						.pipe(Effect.orElseSucceed(() => root))
					const roots = [...new Set([root, canonical])]
					const known = new Set(active.map((unit) => unit.id))
					const archivedSelectors = [
						...(options.archived ? yield* listArchived(root) : []),
						// Panes still running in (or where) an archived item lives.
						...(snapshot?.panes ?? []).flatMap((pane) => {
							const directory = pane.foregroundCwd ?? pane.cwd
							if (pane.agent === null || !directory) return []
							return roots.flatMap((base) => {
								const match = relative(base, directory).match(
									/^(?:archive\/)?tasks\/([^/]+)(?:\/phases\/([^/]+))?/,
								)
								return match
									? [
											{
												taskId: match[1]!,
												...(match[2] ? { phaseId: match[2] } : {}),
											},
										]
									: []
							})
						}),
						...bindings
							.filter((binding) => !known.has(binding.unit))
							.flatMap((binding) => {
								const parsed = parseUnitId(binding.unit)
								return parsed ? [parsed] : []
							}),
					]
					const seen = new Set(known)
					const archived = yield* archivedUnits(
						root,
						archivedSelectors.filter((selector) => {
							const id = selector.phaseId
								? `execution-unit:phase/${selector.taskId}/${selector.phaseId}`
								: `execution-unit:task/${selector.taskId}`
							if (seen.has(id)) return false
							seen.add(id)
							return true
						}),
					)
					const seeds = [...active, ...archived]
					// Ticket and PR lookups are slow external calls; run them together.
					const [ticketRecords, prs] = yield* Effect.all(
						[
							tickets.readMany(seeds.map((unit) => unit.ticketUrl)),
							Effect.forEach(
								seeds,
								(unit) =>
									pullRequest(unit.pr, loadedConfig.config, unit.archived),
								{ concurrency: PR_CONCURRENCY },
							),
						],
						{ concurrency: "unbounded" },
					)

					const rebase = (path: string) =>
						roots.map((base) =>
							base === root ? path : join(base, path.slice(root.length)),
						)
					const runtimeUnits: RuntimeUnit[] = seeds.map((unit) => {
						const directories = unit.directories.flatMap(rebase)
						return {
							id: unit.id,
							directories,
							checkoutPaths: unit.repo
								? directories.map((directory) =>
										join(directory, "code", unit.repo),
									)
								: [],
						}
					})
					const reconciled = snapshot
						? reconcileRuntime(bindings, snapshot, runtimeUnits)
						: null

					const workbaseCatalog = catalog(graph.nodes, root)
					const units: AttentionUnit[] = seeds.map((unit, index) => {
						const binding = reconciled
							? reconciled.bindings.find(
									(item) => item.binding.unit === unit.id,
								)
							: bindings.find((item) => item.unit === unit.id)
						return {
							item: {
								unit: unit.id,
								kind: unit.kind,
								taskId: unit.taskId,
								...(unit.phaseId ? { phaseId: unit.phaseId } : {}),
								path: unit.path,
								archived: unit.archived,
							},
							parent: unit.parent,
							review: unit.review,
							status: unit.status,
							revision: unit.revision,
							pr: prs[index] ?? null,
							ticket: (unit.ticketUrl && ticketRecords.get(unit.ticketUrl)) || {
								url: null,
								state: "none",
							},
							binding: !binding
								? null
								: "binding" in binding
									? {
											record: binding.binding,
											state: binding.state,
											panes: binding.panes,
										}
									: { record: binding, state: "unknown", panes: [] },
							inferred: (reconciled?.inferred ?? [])
								.filter((item) => item.unit === unit.id)
								.map(({ matchedBy, pane }) => ({ matchedBy, pane })),
							actions: unit.entity
								? catalog(graph.nodes, root, unit.entity)
								: [],
						}
					})
					const jira = loadedConfig.config.tickets?.jira
					return {
						ref: { ...ref, root },
						roots,
						key: canonical,
						source,
						isDefault,
						error: null,
						jira: {
							doneStatus: jira?.doneStatus ?? DEFAULT_JIRA.doneStatus,
							reopenStatus: jira?.reopenStatus ?? DEFAULT_JIRA.reopenStatus,
						},
						units,
						actions: workbaseCatalog,
						claimedPaneIds: reconciled
							? [
									...reconciled.bindings
										.filter((item) => item.state !== "gone")
										.flatMap((item) => item.panes.map((pane) => pane.paneId)),
									...reconciled.inferred.map((item) => item.pane.paneId),
								]
							: [],
					} satisfies AttentionWorkbase
				}).pipe(
					Effect.catch((error) =>
						Effect.succeed<AttentionWorkbase>({
							ref,
							roots: [ref.root],
							key: ref.root,
							source,
							isDefault,
							error: message(error),
							jira: DEFAULT_JIRA,
							units: [],
							actions: [],
							claimedPaneIds: [],
						}),
					),
				)

			const workbaseRefs = (
				options: SupervisionOptions,
				panes: readonly RuntimePane[],
			) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const workbases = yield* WorkbaseService
					const cwd = options.cwd ?? process.cwd()
					const registrations = yield* workbases.listRegistrations(
						options.configDirectory,
					)
					const registered = (path: string) =>
						registrations.workbases.find((entry) => entry.path === path)
					const refFor = (path: string, source: WorkbaseSource) => {
						const entry = registered(path)
						return {
							ref: {
								id: entry?.id ?? null,
								name: entry?.name ?? null,
								root: path,
							},
							source: entry ? ("registered" as const) : source,
							isDefault:
								entry !== undefined && entry.id === registrations.defaultId,
						}
					}
					const refs: ReturnType<typeof refFor>[] = []
					const roots = new Map<string, string>()
					const canonicalOf = (path: string) =>
						fs.realPath(path).pipe(Effect.orElseSucceed(() => path))
					const push = (path: string, source: WorkbaseSource) =>
						Effect.gen(function* () {
							const canonical = yield* canonicalOf(path)
							if (roots.has(path) || roots.has(canonical)) return
							roots.set(path, canonical)
							roots.set(canonical, canonical)
							refs.push(refFor(path, source))
						})
					for (const entry of registrations.workbases)
						yield* push(entry.path, "registered")
					const add = (path: string, source: WorkbaseSource) =>
						Effect.gen(function* () {
							const discovered = yield* workbases
								.discover(path)
								.pipe(Effect.orElseSucceed(() => null))
							if (discovered) yield* push(discovered, source)
						})
					yield* add(cwd, "current")
					// Live agents may run in workbases that were never registered.
					for (const path of new Set(
						panes.flatMap((pane) => {
							const directory = pane.foregroundCwd ?? pane.cwd
							return pane.agent !== null && directory ? [directory] : []
						}),
					)) {
						yield* add(path, "runtime")
					}
					if (!options.workbase) return { inspect: refs, otherRoots: [] }
					// A selected workbase is inspected alone; the others only mark
					// which panes belong elsewhere.
					const selected = yield* workbases.resolveRegistered(
						options.workbase,
						options.configDirectory,
						cwd,
					)
					const selectedCanonical = yield* canonicalOf(selected)
					const otherRoots = refs
						.map((item) => item.ref.root)
						.filter((root) => roots.get(root) !== selectedCanonical)
						.flatMap((root) => [root, roots.get(root)!])
					return {
						inspect: [refFor(selected, "current")],
						otherRoots: [...new Set(otherRoots)],
					}
				})

			const snapshot = (options: SupervisionOptions = {}) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const runtime = yield* RuntimeService
					const provider = yield* runtime.provider(options.env)
					const live: {
						snapshot: RuntimeSnapshot | null
						error: string | null
					} = provider
						? yield* provider.snapshot().pipe(
								Effect.map((snapshot) => ({ snapshot, error: null })),
								Effect.catchTag("RuntimeError", (error) =>
									Effect.succeed({ snapshot: null, error: error.message }),
								),
							)
						: { snapshot: null, error: null }
					const panes: readonly RuntimePane[] = live.snapshot?.panes ?? []
					const { inspect, otherRoots } = yield* workbaseRefs(options, panes)
					const workbases = yield* Effect.forEach(
						inspect,
						({ ref, source, isDefault }) =>
							inspectWorkbase(ref, source, isDefault, live.snapshot, options),
						{ concurrency: WORKBASE_CONCURRENCY },
					)
					const directories = [
						...new Set(
							panes.flatMap((pane) => {
								const cwd = pane.foregroundCwd ?? pane.cwd
								return pane.agent !== null && cwd ? [cwd] : []
							}),
						),
					]
					const exists = yield* Effect.forEach(
						directories,
						(directory) => fs.exists(directory),
						{ concurrency: 16 },
					)
					const missingPaths = directories.filter((_, index) => !exists[index])
					return {
						runtime: {
							provider: provider?.kind ?? null,
							available: live.snapshot !== null,
							error: live.error,
							panes,
						},
						workbases,
						otherRoots,
						missingPaths,
					} satisfies AttentionSnapshot
				})

			return {
				/** Join graph, PR, ticket, and runtime state across workbases. */
				snapshot,
				/** Deterministic attention signals with suggested actions. */
				attention: (options: SupervisionOptions = {}) =>
					Effect.gen(function* () {
						const current = yield* snapshot(options)
						const selected = new Set(
							current.workbases.map((workbase) => workbase.ref.root),
						)
						// A selected workbase excludes panes that belong to no workbase or
						// to another one.
						const signals = attentionSignals(current).filter(
							(signal) =>
								!options.workbase ||
								(signal.subject.workbase !== null &&
									selected.has(signal.subject.workbase.root)),
						)
						const kinds: Record<string, number> = {}
						for (const signal of signals)
							kinds[signal.kind] = (kinds[signal.kind] ?? 0) + 1
						return {
							version: ATTENTION_VERSION,
							generatedAt: new Date().toISOString(),
							runtime: {
								provider: current.runtime.provider,
								available: current.runtime.available,
								error: current.runtime.error,
							},
							workbases: current.workbases.map((workbase) => ({
								...workbase.ref,
								source: workbase.source,
								available: workbase.error === null,
								error: workbase.error,
							})),
							signals,
							summary: { total: signals.length, kinds },
						} satisfies AttentionReport
					}),
			}
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
