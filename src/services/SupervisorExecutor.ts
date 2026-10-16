import { Context, Data, Effect, Layer, Option, Schema } from "effect"
import { dirname, join } from "node:path"
import { ActDiscovery } from "../act-schema"
import {
	ACTION_VERSION,
	SupervisorAction,
	type ActionPrecondition,
} from "../attention-schema"
import { shellCommand } from "../utils/command"
import { archivedTaskDirectory } from "../workbase/archive"
import { documentRevision } from "../workbase/document-revision"
import { parseFrontmatterSync } from "../workbase/frontmatter"
import type {
	RuntimeKind,
	RuntimePane,
	RuntimeProvider,
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
	/** Whether a fresh kickoff is a sensible alternative to this failure. */
	readonly fallbackAllowed?: boolean
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

/** The runtime as seen by one snapshot, or null when unavailable. */
type RuntimeView = {
	readonly kind: RuntimeKind
	readonly panes: readonly RuntimePane[]
} | null

interface RuntimeCheck {
	readonly failures: readonly string[]
	/** Offer the plan's fallback, such as when the bound agent is gone. */
	readonly fallbackAllowed: boolean
}

const RUNTIME_OK: RuntimeCheck = { failures: [], fallbackAllowed: false }

interface ExecutionPlan {
	readonly action: SupervisorAction
	/** Exactly what will run: argv, runtime operation, prompt, or URL. */
	readonly preview: readonly string[]
	/** Destructive actions need a second confirmation. */
	readonly destructive: boolean
	/** File, network, and discovery checks, run before the runtime snapshot. */
	readonly verify: Effect.Effect<readonly string[], never, Services>
	/** Checks against the one runtime snapshot taken right before running. */
	readonly verifyRuntime: (runtime: RuntimeView) => RuntimeCheck
	readonly run: Effect.Effect<string | null, SupervisorActionError, Services>
	/** Offered when the plan cannot run because its agent is gone or blocked. */
	readonly fallback: SupervisorAction | null
}

/** A plan the user confirmed; only `confirm` creates one. */
interface ConfirmedPlan {
	readonly plan: ExecutionPlan
	readonly __confirmed: unique symbol
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
	/** Why the outcome could not be appended to the action log. */
	readonly logError: string | null
}

export interface ExecutorOptions {
	/** The argv that runs this Agency CLI; replaces `agency` in discovered argv. */
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

const absurd = (value: never): string =>
	`Unknown precondition: ${JSON.stringify(value)}`

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

/** Only https URLs open; anything else could launch a local handler. */
const safeUrl = (value: string) => {
	if (value.startsWith("-")) return null
	try {
		const url = new URL(value)
		return url.protocol === "https:" ? url.href : null
	} catch {
		return null
	}
}

const decodeDiscovery = Schema.decodeUnknownOption(
	Schema.Struct({ ok: Schema.Literal(true), result: ActDiscovery }),
)
const decodeAction = Schema.decodeUnknownEffect(SupervisorAction)

const StatusDocument = Schema.Struct({ status: Schema.optional(Schema.String) })
const decodeStatus = Schema.decodeUnknownOption(StatusDocument)

type RuntimePrecondition = Extract<
	ActionPrecondition,
	{ kind: "pane_matches" | "tab_agent_panes" }
>

const isRuntimePrecondition = (
	precondition: ActionPrecondition,
): precondition is RuntimePrecondition =>
	precondition.kind === "pane_matches" ||
	precondition.kind === "tab_agent_panes"

/** Evaluate pane and tab preconditions against one runtime snapshot. */
const checkRuntimePrecondition = (
	precondition: RuntimePrecondition,
	runtime: RuntimeView,
): string | null => {
	if (!runtime) return "The runtime is unavailable"
	if (precondition.runtime !== runtime.kind)
		return `The action targets ${precondition.runtime}, but the runtime is ${runtime.kind}`
	if (precondition.kind === "tab_agent_panes") {
		const current = runtime.panes
			.filter(
				(pane) => pane.tabId === precondition.tabId && pane.agent !== null,
			)
			.map((pane) => pane.paneId)
			.sort()
		const expected = [...precondition.paneIds].sort()
		return current.join("\n") === expected.join("\n")
			? null
			: `Tab ${precondition.tabId}'s agent panes changed`
	}
	const pane = runtime.panes.find((item) => item.paneId === precondition.paneId)
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

/**
 * Whether a pane hosts the expected agent and it can take a prompt now. A
 * fresh kickoff is offered only when that agent is gone or blocked, never
 * while it works, which would start a second session on the unit.
 */
const agentReadiness = (
	runtime: RuntimeView,
	paneId: string,
	expected: {
		readonly agentSessionId: string | null
		readonly tabId: string | null
	},
): RuntimeCheck => {
	const fail = (message: string, fallbackAllowed: boolean) => ({
		failures: [message],
		fallbackAllowed,
	})
	if (!runtime) return fail("The runtime is unavailable", false)
	const pane = runtime.panes.find((item) => item.paneId === paneId)
	if (!pane || pane.agent === null)
		return fail(`The agent in pane ${paneId} is gone`, true)
	if (
		expected.agentSessionId !== null &&
		pane.agentSessionId !== expected.agentSessionId
	)
		return fail(`Pane ${paneId} now hosts a different agent session`, true)
	if (expected.tabId !== null && pane.tabId !== expected.tabId)
		return fail(`Pane ${paneId} moved to tab ${pane.tabId}`, false)
	if (pane.agentStatus === "blocked")
		return fail(`The agent in pane ${paneId} is blocked by a dialog`, true)
	return READY_AGENT.has(pane.agentStatus)
		? RUNTIME_OK
		: fail(
				`The agent in pane ${paneId} is ${pane.agentStatus}; try again once it settles`,
				false,
			)
}

export class SupervisorExecutor extends Context.Service<SupervisorExecutor>()(
	"SupervisorExecutor",
	{
		make: Effect.sync(() => {
			const confirmations = new WeakSet<object>()

			const provider = (env: NodeJS.ProcessEnv | undefined) =>
				Effect.flatMap(RuntimeService, (runtime) => runtime.provider(env))

			const runtimeView = (env: NodeJS.ProcessEnv | undefined) =>
				Effect.gen(function* () {
					const runtime = yield* provider(env)
					if (!runtime) return null
					return yield* runtime.snapshot().pipe(
						Effect.map(
							(snapshot): RuntimeView => ({
								kind: runtime.kind,
								panes: snapshot.panes,
							}),
						),
						Effect.orElseSucceed((): RuntimeView => null),
					)
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

			/** File, document, pull request, and ticket preconditions, in parallel. */
			const checkStatePreconditions = (action: SupervisorAction) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const pullRequests = yield* PullRequestStatusService
					const tickets = yield* TicketService
					const root = workbaseRoot(action)
					const urls = [
						...new Set(
							action.preconditions.flatMap((precondition) =>
								precondition.kind === "pull_request_state" ||
								precondition.kind === "pull_request_head"
									? [precondition.url]
									: [],
							),
						),
					]
					const live = new Map<string, LivePullRequest>(
						yield* Effect.forEach(
							urls,
							(url) =>
								Effect.map(
									pullRequests.read(url, { fresh: true }),
									(pr) => [url, pr] as const,
								),
							{ concurrency: "unbounded" },
						),
					)
					const check = (
						precondition: Exclude<ActionPrecondition, RuntimePrecondition>,
					): Effect.Effect<string | null, never, Services> =>
						Effect.gen(function* () {
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
									if (!unit || !root)
										return `Cannot locate ${precondition.unit}`
									const documents = unitDocuments(root, unit)
									const active = yield* readStatus(documents.active)
									const archived =
										active === null
											? yield* readStatus(documents.archived)
											: null
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
								case "pull_request_state":
								case "pull_request_head": {
									const pr = live.get(precondition.url)!
									if (pr.state !== "available")
										return `Cannot read ${precondition.url}: ${pr.reason}`
									if (precondition.kind === "pull_request_head")
										return pr.headSha === precondition.sha
											? null
											: "The pull request head changed since it was reviewed"
									return (precondition.states as readonly string[]).includes(
										pr.prState,
									)
										? null
										: `The pull request is now ${pr.prState}`
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
								default:
									return absurd(precondition)
							}
						})
					const failures = yield* Effect.forEach(
						action.preconditions.filter(
							(
								precondition,
							): precondition is Exclude<
								ActionPrecondition,
								RuntimePrecondition
							> => !isRuntimePrecondition(precondition),
						),
						check,
						{ concurrency: "unbounded" },
					)
					return failures.filter((failure): failure is string => !!failure)
				})

			const checkRuntimePreconditions = (
				action: SupervisorAction,
				runtime: RuntimeView,
			) =>
				action.preconditions
					.filter(isRuntimePrecondition)
					.flatMap((precondition) => {
						const failure = checkRuntimePrecondition(precondition, runtime)
						return failure ? [failure] : []
					})

			/** Recheck every precondition against fresh state; returns failures. */
			const checkPreconditions = (
				action: SupervisorAction,
				env: NodeJS.ProcessEnv | undefined,
			) =>
				Effect.gen(function* () {
					const state = yield* checkStatePreconditions(action)
					const runtime = yield* runtimeView(env)
					return [...state, ...checkRuntimePreconditions(action, runtime)]
				})

			const runArgv = (
				argv: readonly string[],
				cwd: string | undefined,
				options: ExecutorOptions,
				discovered: boolean,
			) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const resolved =
						discovered && argv[0] === "agency"
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

			const runtimeError = (error: {
				readonly message: string
				readonly code?: string | null
			}) =>
				new SupervisorActionError({
					message: error.message,
					cause: error,
					fallbackAllowed: error.code === "agent_blocked",
				})

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
						"The bound agent is gone or blocked by a dialog; start a new session instead.",
					risk: "reversible",
					subject: { ...action.subject, runtime: [] },
					preconditions: action.preconditions.filter(
						(precondition) => !isRuntimePrecondition(precondition),
					),
					payload: { unit, instructions, via: "kickoff" },
				}
			}

			const promptPlan = (
				action: SupervisorAction,
				paneId: string,
				prompt: string,
				expected: {
					readonly agentSessionId: string | null
					readonly tabId: string | null
				},
				options: ExecutorOptions,
			): ExecutionPlan => ({
				action,
				preview: [
					`Prompt the agent in pane ${paneId}${expected.agentSessionId ? ` (session ${expected.agentSessionId})` : ""}:`,
					prompt,
				],
				destructive: action.risk === "destructive",
				verify: Effect.succeed([]),
				verifyRuntime: (runtime) => agentReadiness(runtime, paneId, expected),
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
					readonly verify?: Effect.Effect<readonly string[], never, Services>
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
						const exists = yield* fs
							.isDirectory(directory)
							.pipe(Effect.orElseSucceed(() => false))
						return [
							...(exists ? [] : [`${directory} does not exist`]),
							...(input.verify ? yield* input.verify : []),
						]
					}),
					verifyRuntime: (runtime) =>
						runtime
							? RUNTIME_OK
							: {
									failures: ["No runtime is available"],
									fallbackAllowed: false,
								},
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

			/**
			 * The live pane hosting a unit's bound agent. Pane IDs are reused, so a
			 * known session must match; a recorded pane counts alone only when its
			 * binding never knew the session.
			 */
			const boundPane = (
				action: Action<"delegate">,
				env: NodeJS.ProcessEnv | undefined,
			) =>
				Effect.gen(function* () {
					const runtime = yield* runtimeView(env)
					if (!runtime) return null
					const agentPane = (paneId: string, session: string | null) =>
						runtime.panes.find(
							(pane) =>
								pane.paneId === paneId &&
								pane.agent !== null &&
								(session === null || pane.agentSessionId === session),
						) ?? null
					for (const ref of action.subject.runtime) {
						const pane = agentPane(ref.paneId, ref.agentSessionId)
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
					if (!binding) return null
					if (binding.agentSessionId === null)
						return agentPane(binding.paneId, null)
					return (
						runtime.panes.find(
							(pane) =>
								pane.agent !== null &&
								pane.agentSessionId === binding.agentSessionId,
						) ?? null
					)
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

			/** The parts of a discovered action that determine what runs. */
			const signature = (entry: {
				readonly command?: readonly string[] | null
				readonly commandTemplate?: readonly string[]
				readonly followUpCommands?: readonly (readonly string[])[]
			}) =>
				JSON.stringify([
					entry.command ?? null,
					entry.commandTemplate ?? null,
					entry.followUpCommands ?? [],
				])

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
					const previewed = signature(entry)
					// Immediately before running, the action must still be discovered
					// exactly as previewed.
					const rediscover = discover(action, options).pipe(
						Effect.map((current) =>
							!current
								? [`Action '${action.payload.actionId}' no longer applies`]
								: !current.available
									? [current.blockedReason ?? `'${current.id}' is unavailable`]
									: signature(current) !== previewed
										? [`'${current.id}' changed since it was previewed`]
										: [],
						),
						Effect.catch((error) => Effect.succeed([error.message])),
					)
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
									verify: rediscover,
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
							verify: rediscover,
							verifyRuntime: () => RUNTIME_OK,
							run: Effect.gen(function* () {
								let detail = yield* runArgv(
									argv,
									action.payload.cwd,
									options,
									true,
								)
								for (const followUp of followUps)
									detail =
										(yield* runArgv(
											followUp,
											action.payload.cwd,
											options,
											true,
										)) ?? detail
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

			const unavailable = (reason: string): Resolution => ({
				kind: "unavailable",
				reason,
				fallback: null,
			})

			const resolveDecoded = (
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
								verifyRuntime: (view) =>
									!view
										? {
												failures: ["The runtime is unavailable"],
												fallbackAllowed: false,
											}
										: view.kind !== runtime
											? {
													failures: [
														`The action targets ${runtime}, but the runtime is ${view.kind}`,
													],
													fallbackAllowed: false,
												}
											: RUNTIME_OK,
								run: Effect.gen(function* () {
									const live: RuntimeProvider = yield* requireRuntime(
										options.env,
									)
									yield* (
										operation === "focus"
											? live.focus(target, id)
											: live.close(target, id)
									).pipe(Effect.mapError(runtimeError))
									return `${operation === "focus" ? "Focused" : "Closed"} ${target} ${id}`
								}),
								fallback: null,
							},
						})
					}
					case "command": {
						if (action.payload.argv[0] === "agency")
							return Effect.succeed(
								unavailable(
									"Agency commands must be agency actions so they are re-resolved",
								),
							)
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
								verifyRuntime: () => RUNTIME_OK,
								run: runArgv(action.payload.argv, cwd, options, false),
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
								{
									agentSessionId: action.payload.agentSessionId,
									tabId:
										action.subject.runtime.find(
											(ref) => ref.paneId === action.payload.paneId,
										)?.tabId ?? null,
								},
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
											{
												agentSessionId: pane.agentSessionId,
												tabId: pane.tabId,
											},
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
						const url = safeUrl(action.payload.url)
						if (!url)
							return Effect.succeed(
								unavailable(`Only https URLs open: ${action.payload.url}`),
							)
						const argv = [
							process.platform === "darwin" ? "open" : "xdg-open",
							url,
						]
						return Effect.succeed({
							kind: "ready",
							plan: {
								action,
								preview: [shellCommand(argv)],
								destructive: false,
								verify: Effect.succeed([]),
								verifyRuntime: () => RUNTIME_OK,
								run: Effect.as(
									runArgv(argv, undefined, options, false),
									`Opened ${url}`,
								),
								fallback: null,
							},
						})
					}
				}
			}

			/**
			 * Validate an action and turn it into an exact, previewable plan. Agency
			 * actions are re-resolved through `agency act --json`; stored argv is
			 * never run.
			 */
			const resolve = (
				action: unknown,
				values: Readonly<Record<string, string>>,
				options: ExecutorOptions,
			) =>
				decodeAction(action).pipe(
					Effect.mapError(
						(error) =>
							new SupervisorActionError({
								message: `Invalid action: ${error.message}`,
								cause: error,
							}),
					),
					Effect.flatMap((decoded) => resolveDecoded(decoded, values, options)),
				)

			/** Append to the action log; returns why that failed, if it did. */
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
				).pipe(
					Effect.as(null as string | null),
					Effect.catch((error) =>
						Effect.succeed(`Unable to write the action log: ${error.message}`),
					),
				)

			/**
			 * Turn the user's confirmation into the only token `execute` accepts.
			 * Destructive plans also need the second confirmation.
			 */
			const confirm = (
				plan: ExecutionPlan,
				proof: {
					readonly confirmed: boolean
					readonly destructiveConfirmed: boolean
				},
				key: string | null,
				options: ExecutorOptions,
			) =>
				Effect.gen(function* () {
					const missing = !proof.confirmed
						? "The action was not confirmed"
						: plan.destructive && !proof.destructiveConfirmed
							? "The destructive action was not confirmed twice"
							: null
					if (missing) {
						yield* record(plan.action, key, "cancelled", missing, options.env)
						return yield* new SupervisorActionError({ message: missing })
					}
					const token = { plan } as ConfirmedPlan
					confirmations.add(token)
					return token
				})

			/**
			 * Recheck state against fresh reads (files and network first, then one
			 * runtime snapshot), run the plan, and append the outcome to the log.
			 */
			const execute = (
				token: ConfirmedPlan,
				key: string | null,
				options: ExecutorOptions,
			) =>
				Effect.gen(function* () {
					const { plan } = token
					const finish = (
						outcome: ExecutionResult["outcome"],
						detail: string | null,
						fallback: SupervisorAction | null,
					) =>
						Effect.map(
							record(
								plan.action,
								key,
								outcome === "skipped" ? "failed" : outcome,
								outcome === "skipped"
									? `Precondition failed: ${detail}`
									: detail,
								options.env,
							),
							(logError): ExecutionResult => ({
								outcome,
								detail,
								fallback,
								logError,
							}),
						)
					if (!confirmations.has(token))
						return yield* finish("failed", "The action was not confirmed", null)
					confirmations.delete(token)
					const [state, planState] = yield* Effect.all(
						[checkStatePreconditions(plan.action), plan.verify],
						{ concurrency: "unbounded" },
					)
					if (state.length || planState.length)
						return yield* finish(
							"skipped",
							[...state, ...planState].join("; "),
							null,
						)
					const runtime = yield* runtimeView(options.env)
					const runtimeFailures = checkRuntimePreconditions(
						plan.action,
						runtime,
					)
					const readiness = plan.verifyRuntime(runtime)
					if (runtimeFailures.length || readiness.failures.length)
						return yield* finish(
							"skipped",
							[...runtimeFailures, ...readiness.failures].join("; "),
							readiness.fallbackAllowed ? plan.fallback : null,
						)
					return yield* plan.run.pipe(
						Effect.flatMap((detail) => finish("succeeded", detail, null)),
						Effect.catch((error) =>
							finish(
								"failed",
								error.message,
								error.fallbackAllowed ? plan.fallback : null,
							),
						),
					)
				})

			return {
				resolve,
				checkPreconditions,
				confirm,
				execute,
				/** Log an action that did not run, such as a declined confirmation. */
				record,
			}
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
