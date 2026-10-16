import { Context, Data, Effect, Layer, Option, Schema } from "effect"
import { dirname, join } from "node:path"
import { ActDiscovery } from "../act-schema"
import {
	ACTION_VERSION,
	type ActionPrecondition,
	type SupervisorAction,
} from "../attention-schema"
import { shellCommand } from "../utils/command"
import { archivedTaskDirectory } from "../workbase/archive"
import { documentRevision } from "../workbase/document-revision"
import { parseFrontmatterSync } from "../workbase/frontmatter"
import type {
	RuntimePane,
	RuntimeProvider,
	RuntimeSnapshot,
} from "../workbase/runtime"
import { FileSystemService } from "./FileSystemService"
import {
	PullRequestStatusService,
	type LivePullRequest,
} from "./PullRequestStatusService"
import { RuntimeBindingService } from "./RuntimeBindingService"
import { RuntimeService } from "./RuntimeService"
import {
	SupervisionStateService,
	type ActionLogEntry,
} from "./SupervisionStateService"
import { TicketService } from "./TicketService"

class SupervisorActionError extends Data.TaggedError("SupervisorActionError")<{
	readonly message: string
	readonly cause?: unknown
}> {}

type Action<T extends SupervisorAction["type"]> = Extract<
	SupervisorAction,
	{ readonly type: T }
>

interface ActionInput {
	readonly id: string
	readonly label: string
	readonly required: boolean
	readonly multiline?: boolean
	readonly option?: string
}

type Services =
	| FileSystemService
	| RuntimeService
	| PullRequestStatusService
	| TicketService
	| RuntimeBindingService
	| SupervisionStateService

interface ExecutionPlan {
	readonly action: SupervisorAction
	/** Exactly what will run: argv, runtime operation, prompt, or URL. */
	readonly preview: readonly string[]
	/** Destructive actions need a second confirmation. */
	readonly destructive: boolean
	/** Plan-specific readiness checks, run with the preconditions. */
	readonly verify: Effect.Effect<readonly string[], never, Services>
	readonly run: Effect.Effect<string | null, SupervisorActionError, Services>
	/** Offered when the plan cannot run, such as a busy bound agent. */
	readonly fallback: SupervisorAction | null
}

type Resolution =
	| { readonly kind: "ready"; readonly plan: ExecutionPlan }
	/** An agency template action needs these input values first. */
	| { readonly kind: "inputs"; readonly inputs: readonly ActionInput[] }
	| {
			readonly kind: "unavailable"
			readonly reason: string
			readonly fallback: SupervisorAction | null
	  }

interface ExecutionResult {
	/** `skipped` when a precondition no longer holds. */
	readonly outcome: "succeeded" | "failed" | "skipped"
	readonly detail: string | null
	readonly fallback: SupervisorAction | null
}

export interface ExecutorOptions {
	/** The argv that runs this Agency CLI; replaces a leading `agency`. */
	readonly agencyCommand: readonly string[]
	readonly env?: NodeJS.ProcessEnv
}

const COMMAND_TIMEOUT_MS = 5 * 60_000
const DISCOVERY_TIMEOUT_MS = 60_000
const READY_AGENT = new Set(["idle", "done"])
const INSTRUCTIONS_ENV = "AGENCY_SUPERVISOR_INSTRUCTIONS"

const parseUnit = (unit: string) => {
	const task = unit.match(/^execution-unit:task\/([^/]+)$/)
	if (task) return { taskId: task[1]! }
	const phase = unit.match(/^execution-unit:phase\/([^/]+)\/([^/]+)$/)
	return phase ? { taskId: phase[1]!, phaseId: phase[2]! } : null
}

const unitLabel = (unit: { taskId: string; phaseId?: string }) =>
	unit.phaseId ? `${unit.taskId}/${unit.phaseId}` : unit.taskId

const unitDocuments = (
	root: string,
	unit: { taskId: string; phaseId?: string },
) => {
	const relative = unit.phaseId
		? join("phases", unit.phaseId, "PHASE.md")
		: "TASK.md"
	return {
		active: join(root, "tasks", unit.taskId, relative),
		archived: join(archivedTaskDirectory(root, unit.taskId), relative),
	}
}

const lastLine = (...outputs: string[]) => {
	for (const output of outputs) {
		const line = output
			.trim()
			.split("\n")
			.map((item) => item.trim())
			.filter(Boolean)
			.at(-1)
		if (line) return line.length > 240 ? `${line.slice(0, 239)}…` : line
	}
	return null
}

const errorMessage = (error: unknown) =>
	error instanceof Error
		? error.message
		: typeof error === "object" &&
			  error !== null &&
			  "message" in error &&
			  typeof error.message === "string"
			? error.message
			: String(error)

/**
 * Substitute `<input>` placeholders and append optional inputs by their option.
 * Empty optional values are omitted.
 */
const fillTemplate = (
	template: readonly string[],
	inputs: readonly ActionInput[],
	values: Readonly<Record<string, string>>,
) => {
	const argv = template.map((part) => {
		const match = part.match(/^<([^>]+)>$/)
		return match && values[match[1]!] !== undefined ? values[match[1]!]! : part
	})
	for (const input of inputs) {
		const value = values[input.id]
		if (input.option && !input.required && value) argv.push(input.option, value)
	}
	return argv
}

const decodeDiscovery = Schema.decodeUnknownOption(
	Schema.Struct({ ok: Schema.Literal(true), result: ActDiscovery }),
)

const StatusDocument = Schema.Struct({ status: Schema.optional(Schema.String) })
const decodeStatus = Schema.decodeUnknownOption(StatusDocument)

export class SupervisorExecutor extends Context.Service<SupervisorExecutor>()(
	"SupervisorExecutor",
	{
		make: Effect.sync(() => {
			const provider = (env: NodeJS.ProcessEnv | undefined) =>
				Effect.flatMap(RuntimeService, (runtime) => runtime.provider(env))

			const freshSnapshot = (env: NodeJS.ProcessEnv | undefined) =>
				Effect.gen(function* () {
					const runtime = yield* provider(env)
					if (!runtime) return null
					return yield* runtime
						.snapshot()
						.pipe(Effect.orElseSucceed((): RuntimeSnapshot | null => null))
				})

			const workbaseRoot = (action: SupervisorAction) =>
				action.type === "agency"
					? action.payload.cwd
					: (action.subject.workbase?.root ?? null)

			const readStatus = (path: string) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const content = yield* fs
						.readFile(path)
						.pipe(Effect.orElseSucceed(() => null))
					if (content === null) return null
					try {
						const decoded = decodeStatus(
							parseFrontmatterSync(content, path).data,
						)
						return Option.isSome(decoded)
							? (decoded.value.status ?? "open")
							: null
					} catch {
						return null
					}
				})

			/** Recheck every precondition against fresh state; returns failures. */
			const checkPreconditions = (
				action: SupervisorAction,
				env: NodeJS.ProcessEnv | undefined,
			) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const pullRequests = yield* PullRequestStatusService
					const tickets = yield* TicketService
					const root = workbaseRoot(action)
					let snapshot: RuntimeSnapshot | null | undefined
					const panes = function* () {
						if (snapshot === undefined) snapshot = yield* freshSnapshot(env)
						return snapshot?.panes ?? null
					}
					const pullRequestCache = new Map<string, LivePullRequest>()
					const pullRequest = function* (url: string) {
						const cached = pullRequestCache.get(url)
						if (cached) return cached
						const live = yield* pullRequests.read(url, { fresh: true })
						pullRequestCache.set(url, live)
						return live
					}
					const failures: string[] = []
					const check = function* (precondition: ActionPrecondition) {
						switch (precondition.kind) {
							case "document_revision": {
								const content = yield* fs
									.readFile(precondition.path)
									.pipe(Effect.orElseSucceed(() => null))
								if (content === null)
									return `${precondition.path} no longer exists`
								return documentRevision(content) === precondition.sha256
									? null
									: `${precondition.path} changed`
							}
							case "item_status":
							case "item_archived": {
								const unit = parseUnit(precondition.unit)
								if (!unit || !root) return `Cannot locate ${precondition.unit}`
								const documents = unitDocuments(root, unit)
								const active = yield* readStatus(documents.active)
								const archived =
									active === null ? yield* readStatus(documents.archived) : null
								if (active === null && archived === null)
									return `${unitLabel(unit)} no longer exists`
								if (precondition.kind === "item_archived") {
									const isArchived = active === null
									return isArchived === precondition.archived
										? null
										: `${unitLabel(unit)} is ${isArchived ? "" : "no longer "}archived`
								}
								const status = active ?? archived!
								return (precondition.statuses as readonly string[]).includes(
									status,
								)
									? null
									: `${unitLabel(unit)} is now ${status}`
							}
							case "pane_matches": {
								const live = yield* panes()
								if (!live) return "The runtime is unavailable"
								const pane = live.find(
									(item) => item.paneId === precondition.paneId,
								)
								if (!pane) return `Pane ${precondition.paneId} is gone`
								if (pane.tabId !== precondition.tabId)
									return `Pane ${precondition.paneId} moved to tab ${pane.tabId}`
								if ((pane.foregroundCwd ?? pane.cwd) !== precondition.cwd)
									return `Pane ${precondition.paneId} changed directory`
								if (pane.agentSessionId !== precondition.agentSessionId)
									return `Pane ${precondition.paneId} hosts a different session`
								return precondition.agentStatuses.includes(pane.agentStatus)
									? null
									: `The agent in pane ${precondition.paneId} is ${pane.agentStatus}`
							}
							case "tab_agent_panes": {
								const live = yield* panes()
								if (!live) return "The runtime is unavailable"
								const current = live
									.filter(
										(pane) =>
											pane.tabId === precondition.tabId && pane.agent !== null,
									)
									.map((pane) => pane.paneId)
									.sort()
								const expected = [...precondition.paneIds].sort()
								return current.join("\n") === expected.join("\n")
									? null
									: `Tab ${precondition.tabId}'s agent panes changed`
							}
							case "pull_request_state": {
								const live = yield* pullRequest(precondition.url)
								if (live.state !== "available")
									return `Cannot read ${precondition.url}: ${live.reason}`
								return (precondition.states as readonly string[]).includes(
									live.prState,
								)
									? null
									: `The pull request is now ${live.prState}`
							}
							case "pull_request_head": {
								const live = yield* pullRequest(precondition.url)
								if (live.state !== "available")
									return `Cannot read ${precondition.url}: ${live.reason}`
								return live.headSha === precondition.sha
									? null
									: "The pull request head changed since it was reviewed"
							}
							case "ticket_status_category": {
								const ticket = yield* tickets.read(precondition.url, {
									fresh: true,
								})
								if (ticket.state !== "available")
									return `Cannot read ${precondition.url}`
								return precondition.statusCategories.includes(
									ticket.statusCategory,
								)
									? null
									: `${ticket.key} is now ${ticket.status}`
							}
							case "path_exists": {
								const exists = yield* fs
									.exists(precondition.path)
									.pipe(Effect.orElseSucceed(() => !precondition.exists))
								return exists === precondition.exists
									? null
									: `${precondition.path} ${exists ? "exists again" : "no longer exists"}`
							}
						}
					}
					for (const precondition of action.preconditions) {
						const failure = yield* Effect.gen(() => check(precondition))
						if (failure) failures.push(failure)
					}
					return failures
				})

			const runArgv = (
				argv: readonly string[],
				cwd: string | undefined,
				options: ExecutorOptions,
			) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const resolved =
						argv[0] === "agency"
							? [...options.agencyCommand, ...argv.slice(1)]
							: [...argv]
					const result = yield* fs
						.runCommand(resolved, {
							cwd,
							captureOutput: true,
							timeoutMs: COMMAND_TIMEOUT_MS,
						})
						.pipe(
							Effect.mapError(
								(error) =>
									new SupervisorActionError({
										message: error.message,
										cause: error,
									}),
							),
						)
					if (result.exitCode !== 0)
						return yield* new SupervisorActionError({
							message:
								lastLine(result.stderr, result.stdout) ??
								`${shellCommand(argv)} exited with code ${result.exitCode}`,
						})
					return lastLine(result.stdout, result.stderr)
				})

			const runtimeError = (error: { readonly message: string }) =>
				new SupervisorActionError({ message: error.message, cause: error })

			const requireRuntime = (env: NodeJS.ProcessEnv | undefined) =>
				Effect.flatMap(provider(env), (runtime) =>
					runtime
						? Effect.succeed(runtime)
						: Effect.fail(
								new SupervisorActionError({
									message: "No runtime is available",
								}),
							),
				)

			const delegateFallback = (
				action: SupervisorAction,
				instructions: string,
			): SupervisorAction | null => {
				const unit = action.subject.item?.unit
				if (!unit || action.subject.item?.archived) return null
				return {
					version: ACTION_VERSION,
					id: `${action.id}/kickoff`,
					type: "delegate",
					title: "Delegate to a fresh agent",
					rationale:
						"The bound agent is gone, busy, or blocked by a dialog; start a new session instead.",
					risk: "reversible",
					subject: { ...action.subject, runtime: [] },
					preconditions: action.preconditions.filter(
						(precondition) =>
							precondition.kind !== "pane_matches" &&
							precondition.kind !== "tab_agent_panes",
					),
					payload: { unit, instructions, via: "kickoff" },
				}
			}

			/** Whether a pane hosts an agent that can take a prompt now. */
			const agentReadiness = (
				paneId: string,
				env: NodeJS.ProcessEnv | undefined,
			) =>
				Effect.map(freshSnapshot(env), (snapshot): string | null => {
					if (!snapshot) return "The runtime is unavailable"
					const pane = snapshot.panes.find((item) => item.paneId === paneId)
					if (!pane) return `Pane ${paneId} is gone`
					if (pane.agent === null) return `No agent runs in pane ${paneId}`
					if (pane.agentStatus === "blocked")
						return `The agent in pane ${paneId} is blocked by a dialog`
					return READY_AGENT.has(pane.agentStatus)
						? null
						: `The agent in pane ${paneId} is ${pane.agentStatus}`
				})

			const promptPlan = (
				action: SupervisorAction,
				paneId: string,
				prompt: string,
				options: ExecutorOptions,
			): ExecutionPlan => ({
				action,
				preview: [`Prompt the agent in pane ${paneId}:`, prompt],
				destructive: action.risk === "destructive",
				verify: Effect.map(agentReadiness(paneId, options.env), (reason) =>
					reason ? [reason] : [],
				),
				run: Effect.gen(function* () {
					const runtime = yield* requireRuntime(options.env)
					yield* runtime
						.promptAgent(paneId, prompt)
						.pipe(Effect.mapError(runtimeError))
					return `Prompted pane ${paneId}`
				}),
				fallback: delegateFallback(action, prompt),
			})

			const launchPlan = (
				action: SupervisorAction,
				input: {
					readonly root: string
					readonly unit: { taskId: string; phaseId?: string }
					readonly argv: readonly string[]
					readonly instructions?: string
				},
				options: ExecutorOptions,
			): ExecutionPlan => {
				const directory = dirname(unitDocuments(input.root, input.unit).active)
				const command = [
					shellCommand(
						input.argv[0] === "agency"
							? [...options.agencyCommand, ...input.argv.slice(1)]
							: input.argv,
					),
					...(input.instructions
						? [`--instructions "$${INSTRUCTIONS_ENV}"`]
						: []),
				].join(" ")
				return {
					action,
					preview: [
						`In a new unfocused tab at ${directory}:`,
						shellCommand([
							...input.argv,
							...(input.instructions
								? ["--instructions", input.instructions]
								: []),
						]),
					],
					destructive: action.risk === "destructive",
					verify: Effect.gen(function* () {
						const fs = yield* FileSystemService
						return (yield* fs
							.isDirectory(directory)
							.pipe(Effect.orElseSucceed(() => false)))
							? []
							: [`${directory} does not exist`]
					}),
					run: Effect.gen(function* () {
						const runtime = yield* requireRuntime(options.env)
						const launched = yield* runtime
							.launch({
								workspaceId: runtime.currentLocation()?.workspaceId ?? null,
								cwd: directory,
								label: unitLabel(input.unit),
								command,
								...(input.instructions
									? { env: { [INSTRUCTIONS_ENV]: input.instructions } }
									: {}),
							})
							.pipe(Effect.mapError(runtimeError))
						return `Launched in tab ${launched.tabId}`
					}),
					fallback: null,
				}
			}

			const kickoffPlan = (
				action: Action<"delegate">,
				options: ExecutorOptions,
			): Resolution => {
				const unit = parseUnit(action.payload.unit)
				const root = action.subject.workbase?.root
				if (!unit || !root)
					return {
						kind: "unavailable",
						reason: `Cannot locate ${action.payload.unit}`,
						fallback: null,
					}
				return {
					kind: "ready",
					plan: launchPlan(
						action,
						{
							root,
							unit,
							argv: [
								"agency",
								"work",
								"--task",
								unit.taskId,
								...(unit.phaseId ? ["--phase", unit.phaseId] : []),
								"--auto",
							],
							instructions: action.payload.instructions.trim() || undefined,
						},
						options,
					),
				}
			}

			/** The live pane bound to (or hosting) a unit, if any. */
			const boundPane = (
				action: Action<"delegate">,
				env: NodeJS.ProcessEnv | undefined,
			) =>
				Effect.gen(function* () {
					const snapshot = yield* freshSnapshot(env)
					if (!snapshot) return null
					const live = (paneId: string) =>
						snapshot.panes.find(
							(pane) => pane.paneId === paneId && pane.agent !== null,
						) ?? null
					for (const ref of action.subject.runtime) {
						const pane = live(ref.paneId)
						if (pane) return pane
					}
					const root = action.subject.workbase?.root
					if (!root) return null
					const bindings = yield* (yield* RuntimeBindingService)
						.list(root, env)
						.pipe(Effect.orElseSucceed(() => []))
					const binding = bindings.find(
						(item) => item.unit === action.payload.unit,
					)
					const pane: RuntimePane | null = binding
						? (snapshot.panes.find(
								(item) =>
									item.agent !== null &&
									binding.agentSessionId !== null &&
									item.agentSessionId === binding.agentSessionId,
							) ?? live(binding.paneId))
						: null
					return pane
				})

			const discover = (action: Action<"agency">, options: ExecutorOptions) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const { selector } = action.payload
					const argv = [
						...options.agencyCommand,
						"act",
						"--action",
						action.payload.actionId,
						...(selector
							? [
									"--task",
									selector.task,
									...(selector.phase ? ["--phase", selector.phase] : []),
								]
							: []),
						"--auto",
						"--json",
					]
					const result = yield* fs
						.runCommand(argv, {
							cwd: action.payload.cwd,
							captureOutput: true,
							timeoutMs: DISCOVERY_TIMEOUT_MS,
						})
						.pipe(
							Effect.mapError(
								(error) =>
									new SupervisorActionError({
										message: `Unable to rediscover '${action.payload.actionId}': ${error.message}`,
										cause: error,
									}),
							),
						)
					let parsed: unknown
					try {
						parsed = JSON.parse(result.stdout)
					} catch {
						parsed = undefined
					}
					const decoded = decodeDiscovery(parsed)
					if (Option.isNone(decoded))
						return yield* new SupervisorActionError({
							message: `Unable to rediscover '${action.payload.actionId}': ${lastLine(result.stderr, result.stdout) ?? "invalid response"}`,
						})
					const discovery = decoded.value.result
					const candidates = selector
						? discovery.targets.flatMap((target) => [
								...target.actions,
								...target.blockedActions,
							])
						: discovery.workbase.actions
					return (
						candidates.find(
							(candidate) => candidate.id === action.payload.actionId,
						) ?? null
					)
				})

			const agencyResolution = (
				action: Action<"agency">,
				values: Readonly<Record<string, string>>,
				options: ExecutorOptions,
			) =>
				Effect.gen(function* () {
					const entry = yield* discover(action, options)
					if (!entry)
						return {
							kind: "unavailable",
							reason: `Action '${action.payload.actionId}' no longer applies`,
							fallback: null,
						} satisfies Resolution
					if (!entry.available)
						return {
							kind: "unavailable",
							reason: entry.blockedReason ?? "Unavailable",
							fallback: null,
						} satisfies Resolution
					const inputs = entry.inputs ?? []
					const merged = { ...action.payload.values, ...values }
					let argv: readonly string[]
					if (entry.command) argv = entry.command
					else if (entry.commandTemplate) {
						const missing = inputs.filter(
							(input) => merged[input.id] === undefined,
						)
						if (missing.length)
							return { kind: "inputs", inputs: missing } as const
						argv = fillTemplate(entry.commandTemplate, inputs, merged)
					} else
						return {
							kind: "unavailable",
							reason: `Action '${entry.id}' has no command`,
							fallback: null,
						} satisfies Resolution
					const selector = action.payload.selector
					if (entry.id === "work" && selector)
						return {
							kind: "ready",
							plan: launchPlan(
								action,
								{
									root: action.payload.cwd,
									unit: { taskId: selector.task, phaseId: selector.phase },
									argv,
								},
								options,
							),
						} satisfies Resolution
					const followUps = entry.followUpCommands ?? []
					const bind = action.payload.bindRuntime
					const createdTask =
						bind && entry.id.startsWith("task-create") ? merged.id : undefined
					return {
						kind: "ready",
						plan: {
							action,
							preview: [argv, ...followUps].map(shellCommand),
							destructive: action.risk === "destructive",
							verify: Effect.succeed([]),
							run: Effect.gen(function* () {
								let detail = yield* runArgv(argv, action.payload.cwd, options)
								for (const followUp of followUps)
									detail =
										(yield* runArgv(followUp, action.payload.cwd, options)) ??
										detail
								if (bind && createdTask) {
									yield* (yield* RuntimeBindingService)
										.record(
											{
												root: action.payload.cwd,
												unit: `execution-unit:task/${createdTask}`,
												runtime: bind.runtime,
												paneId: bind.paneId,
												tabId: bind.tabId,
												workspaceId: bind.workspaceId,
												agent: bind.agent,
												agentSessionId: bind.agentSessionId,
												agencySessionId: null,
											},
											options.env,
										)
										.pipe(
											Effect.mapError(
												(error) =>
													new SupervisorActionError({
														message: `Created ${createdTask} but could not bind pane ${bind.paneId}: ${errorMessage(error)}`,
														cause: error,
													}),
											),
										)
									detail = `Created ${createdTask} and bound pane ${bind.paneId}`
								}
								return detail
							}),
							fallback: null,
						},
					} satisfies Resolution
				})

			/**
			 * Turn an action into an exact, previewable plan. Agency actions are
			 * re-resolved through `agency act --json`; stored argv is never run.
			 */
			const resolve = (
				action: SupervisorAction,
				values: Readonly<Record<string, string>>,
				options: ExecutorOptions,
			): Effect.Effect<Resolution, SupervisorActionError, Services> => {
				switch (action.type) {
					case "agency":
						return agencyResolution(action, values, options)
					case "runtime": {
						const { operation, target, id, runtime } = action.payload
						return Effect.succeed({
							kind: "ready",
							plan: {
								action,
								preview: [`${runtime}: ${operation} ${target} ${id}`],
								destructive: action.risk === "destructive",
								verify: Effect.succeed([]),
								run: Effect.gen(function* () {
									const provider: RuntimeProvider = yield* requireRuntime(
										options.env,
									)
									yield* (
										operation === "focus"
											? provider.focus(target, id)
											: provider.close(target, id)
									).pipe(Effect.mapError(runtimeError))
									return `${operation === "focus" ? "Focused" : "Closed"} ${target} ${id}`
								}),
								fallback: null,
							},
						})
					}
					case "command": {
						const cwd =
							action.payload.cwd ?? action.subject.workbase?.root ?? undefined
						return Effect.succeed({
							kind: "ready",
							plan: {
								action,
								preview: [
									shellCommand(action.payload.argv),
									...(cwd ? [`in ${cwd}`] : []),
								],
								destructive: action.risk === "destructive",
								verify: Effect.succeed([]),
								run: runArgv(action.payload.argv, cwd, options),
								fallback: null,
							},
						})
					}
					case "prompt_agent":
						return Effect.succeed({
							kind: "ready",
							plan: promptPlan(
								action,
								action.payload.paneId,
								action.payload.prompt,
								options,
							),
						})
					case "delegate":
						if (action.payload.via === "kickoff")
							return Effect.succeed(kickoffPlan(action, options))
						return Effect.map(boundPane(action, options.env), (pane) =>
							pane
								? {
										kind: "ready",
										plan: promptPlan(
											action,
											pane.paneId,
											action.payload.instructions,
											options,
										),
									}
								: {
										kind: "unavailable",
										reason: `No live agent is bound to ${action.payload.unit}`,
										fallback: delegateFallback(
											action,
											action.payload.instructions,
										),
									},
						)
					case "open_url": {
						const argv = [
							process.platform === "darwin" ? "open" : "xdg-open",
							action.payload.url,
						]
						return Effect.succeed({
							kind: "ready",
							plan: {
								action,
								preview: [shellCommand(argv)],
								destructive: false,
								verify: Effect.succeed([]),
								run: Effect.as(
									runArgv(argv, undefined, options),
									`Opened ${action.payload.url}`,
								),
								fallback: null,
							},
						})
					}
				}
			}

			const record = (
				action: SupervisorAction,
				key: string | null,
				outcome: ActionLogEntry["outcome"],
				detail: string | null,
				env: NodeJS.ProcessEnv | undefined,
			) =>
				Effect.flatMap(SupervisionStateService, (state) =>
					state.appendAction(
						{
							key,
							actionId: action.id,
							type: action.type,
							title: action.title,
							outcome,
							detail,
						},
						env,
					),
				).pipe(Effect.ignore)

			/**
			 * Recheck preconditions and plan readiness against fresh state, run the
			 * plan, and append the outcome to the action log.
			 */
			const execute = (
				plan: ExecutionPlan,
				key: string | null,
				options: ExecutorOptions,
			) =>
				Effect.gen(function* () {
					const failures = [
						...(yield* checkPreconditions(plan.action, options.env)),
						...(yield* plan.verify),
					]
					if (failures.length) {
						const detail = failures.join("; ")
						yield* record(
							plan.action,
							key,
							"failed",
							`Precondition failed: ${detail}`,
							options.env,
						)
						return {
							outcome: "skipped",
							detail,
							fallback: plan.fallback,
						} satisfies ExecutionResult
					}
					return yield* plan.run.pipe(
						Effect.flatMap((detail) =>
							Effect.as(
								record(plan.action, key, "succeeded", detail, options.env),
								{
									outcome: "succeeded",
									detail,
									fallback: null,
								} satisfies ExecutionResult,
							),
						),
						Effect.catch((error) =>
							Effect.as(
								record(plan.action, key, "failed", error.message, options.env),
								{
									outcome: "failed",
									detail: error.message,
									fallback: plan.fallback,
								} satisfies ExecutionResult,
							),
						),
					)
				})

			return {
				resolve,
				checkPreconditions,
				execute,
				/** Log an action that was not run, such as a declined confirmation. */
				record,
			}
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
