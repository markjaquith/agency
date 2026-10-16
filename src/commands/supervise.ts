import { Deferred, Effect, FiberHandle, Queue, Stream } from "effect"
import { dirname, join } from "node:path"
import type { AttentionReport, SupervisorAction } from "../attention-schema"
import { FileSystemService } from "../services/FileSystemService"
import { RuntimeService } from "../services/RuntimeService"
import { SupervisionService } from "../services/SupervisionService"
import { SupervisionStateService } from "../services/SupervisionStateService"
import {
	SupervisorExecutor,
	type ExecutorOptions,
} from "../services/SupervisorExecutor"
import type { BaseCommandOptions } from "../utils/command"
import type { RuntimeSnapshot, RuntimeSubscription } from "../workbase/runtime"
import {
	superviseModel,
	UNMANAGED_GROUP,
	type Annotate,
	type SuperviseItem,
} from "../workbase/supervise-view"

type NoticeTone = "info" | "success" | "warning" | "error"

interface ConfirmRequest {
	readonly title: string
	readonly rationale: string
	readonly risk: SupervisorAction["risk"]
	readonly preview: readonly string[]
	readonly destructive: boolean
}

/** What the user confirmed: once, and for destructive actions, twice. */
interface Confirmation {
	readonly confirmed: boolean
	readonly destructiveConfirmed: boolean
}

/** The terminal surface the supervisor drives; the OpenTUI session or a fake. */
interface SupervisorUi {
	readonly update: (model: ReturnType<typeof superviseModel>) => void
	readonly status: (status: {
		readonly live?: boolean
		readonly refreshing?: boolean
		readonly busy?: boolean
		readonly updatedAt?: Date | null
	}) => void
	readonly notice: (text: string, tone?: NoticeTone) => void
	readonly confirm: (request: ConfirmRequest) => Promise<Confirmation>
	readonly text: (prompt: string) => Promise<string | null>
	readonly choose: (
		prompt: string,
		choices: readonly { readonly key: string; readonly label: string }[],
	) => Promise<string | null>
	readonly suspend: () => void
	readonly resume: () => void
	readonly close: () => Promise<void>
}

interface SupervisorUiHandlers {
	readonly onExecute: (item: SuperviseItem, action: SupervisorAction) => void
	readonly onFocus: (item: SuperviseItem) => void
	readonly onRefresh: () => void
	readonly onEditPrompt: (item: SuperviseItem | null) => void
	readonly onSnooze: (item: SuperviseItem) => void
	readonly onDismiss: (item: SuperviseItem) => void
	readonly onQuit: () => void
}

type OpenSupervisorUi = (
	handlers: SupervisorUiHandlers,
) => Promise<SupervisorUi>

interface SuperviseOptions extends BaseCommandOptions {
	readonly workbase?: string
	readonly configDirectory?: string
	readonly env?: NodeJS.ProcessEnv
	/** The argv that runs this Agency CLI for re-resolved agency actions. */
	readonly agencyCommand?: readonly string[]
	/** Seconds between full refreshes without runtime events. */
	readonly pollSeconds?: number
	/** Minimum milliseconds between refreshes. */
	readonly minRefreshMs?: number
	/** LLM judgment layered over signals, once triage is available. */
	readonly annotate?: Annotate
}

type Intent =
	| {
			readonly kind: "execute"
			readonly item: SuperviseItem
			readonly action: SupervisorAction
	  }
	| { readonly kind: "focus"; readonly item: SuperviseItem }
	| { readonly kind: "edit"; readonly item: SuperviseItem | null }
	| { readonly kind: "snooze"; readonly item: SuperviseItem }
	| { readonly kind: "dismiss"; readonly item: SuperviseItem }

const SNOOZES = [
	{ key: "3600000", label: "1 hour" },
	{ key: "14400000", label: "4 hours" },
	{ key: "86400000", label: "1 day" },
	{ key: "604800000", label: "1 week" },
] as const

const DEBOUNCE_MS = 400
const MIN_REFRESH_MS = 2_500
const RESUBSCRIBE_MS = 5_000
/** A subscription that survives this long without failing counts as live. */
const LIVE_AFTER_MS = 2_000

/** The per-workbase prompt the supervisor's `e` key edits. */
const supervisionPromptPath = (root: string) =>
	join(root, ".agency", "supervisor-prompt.md")

const defaultAgencyCommand = () =>
	process.argv[1] ? [process.execPath, process.argv[1]] : ["agency"]

const defaultOpenUi: OpenSupervisorUi = async (handlers) => {
	const { loadSupervisorUi } = await import("../utils/interactive-loader")
	return (await loadSupervisorUi()).createSupervisorSession(handlers)
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

const subscriptions = (
	snapshot: RuntimeSnapshot | null,
): RuntimeSubscription[] => [
	{ type: "pane.created" },
	{ type: "pane.closed" },
	{ type: "pane.moved" },
	{ type: "pane.updated" },
	{ type: "tab.closed" },
	{ type: "workspace.closed" },
	...(snapshot?.panes ?? [])
		.filter((pane) => pane.agent !== null)
		.map((pane) => ({
			type: "pane.agent_status_changed" as const,
			paneId: pane.paneId,
		})),
]

export const supervise = (
	options: SuperviseOptions = {},
	openUi: OpenSupervisorUi = defaultOpenUi,
) =>
	Effect.gen(function* () {
		if (options.inputAllowed === false)
			return yield* Effect.fail(
				new Error(
					"agency supervise requires an interactive terminal; use agency attention --json for automation",
				),
			)
		const supervision = yield* SupervisionService
		const stateService = yield* SupervisionStateService
		const executor = yield* SupervisorExecutor
		const runtimeService = yield* RuntimeService
		const fs = yield* FileSystemService
		const env = options.env ?? process.env
		const executorOptions: ExecutorOptions = {
			agencyCommand: options.agencyCommand ?? defaultAgencyCommand(),
			env,
		}
		// One intent at a time: while one is pending, further key presses are
		// dropped rather than queued to replay against a changed list.
		const intents = yield* Queue.dropping<Intent>(1)
		const quit = yield* Deferred.make<void>()
		let pending = false
		const refreshes = yield* Queue.sliding<true>(1)
		const requestRefresh = () => {
			Queue.offerUnsafe(refreshes, true)
		}
		let ui: SupervisorUi | undefined
		const offer = (intent: Intent) => {
			if (pending) return
			pending = true
			ui?.status({ busy: true })
			Queue.offerUnsafe(intents, intent)
		}
		const opened = yield* Effect.acquireRelease(
			Effect.tryPromise({
				try: () =>
					openUi({
						onExecute: (item, action) =>
							offer({ kind: "execute", item, action }),
						onFocus: (item) => offer({ kind: "focus", item }),
						onRefresh: requestRefresh,
						onEditPrompt: (item) => offer({ kind: "edit", item }),
						onSnooze: (item) => offer({ kind: "snooze", item }),
						onDismiss: (item) => offer({ kind: "dismiss", item }),
						onQuit: () => {
							Deferred.doneUnsafe(quit, Effect.void)
						},
					}),
				catch: (cause) => new Error("Unable to open the supervisor", { cause }),
			}),
			(ui) => Effect.promise(() => ui.close()),
		)
		ui = opened
		const surface = opened
		const ask = <A>(run: () => Promise<A>) => Effect.promise(run)

		const view: {
			report: AttentionReport | null
			snapshot: RuntimeSnapshot | null
			subscriptionKey: string | null
		} = { report: null, snapshot: null, subscriptionKey: null }

		const render = Effect.gen(function* () {
			if (!view.report) return
			const [snoozes, dismissals] = yield* Effect.all([
				stateService.snoozes(env),
				stateService.dismissals(env),
			])
			surface.update(
				superviseModel(view.report, {
					snapshot: view.snapshot,
					state: { snoozes, dismissals },
					annotate: options.annotate,
				}),
			)
		})

		const provider = runtimeService.provider(env)
		const subscription = yield* FiberHandle.make()
		const subscribe = (snapshot: RuntimeSnapshot | null) =>
			Effect.gen(function* () {
				const runtime = yield* provider
				const wanted = subscriptions(snapshot)
				const key = JSON.stringify(wanted)
				if (!runtime || key === view.subscriptionKey) return
				view.subscriptionKey = key
				yield* FiberHandle.run(
					subscription,
					Effect.gen(function* () {
						while (true) {
							yield* Effect.raceFirst(
								runtime.subscribe(wanted).pipe(
									Stream.runForEach(() =>
										Effect.sync(() => {
											surface.status({ live: true })
											requestRefresh()
										}),
									),
									Effect.catch(() => Effect.void),
								),
								// Never resolves: it only marks a healthy subscription live.
								Effect.sleep(LIVE_AFTER_MS).pipe(
									Effect.andThen(
										Effect.sync(() => surface.status({ live: true })),
									),
									Effect.andThen(Effect.never),
								),
							)
							surface.status({ live: false })
							yield* Effect.sleep(RESUBSCRIBE_MS)
						}
					}),
				)
			})

		const refresh = Effect.gen(function* () {
			surface.status({ refreshing: true })
			const runtime = yield* provider
			const [report, snapshot] = yield* Effect.all(
				[
					supervision.attention({
						workbase: options.workbase,
						cwd: options.cwd,
						configDirectory: options.configDirectory,
						env,
					}),
					runtime
						? runtime
								.snapshot()
								.pipe(Effect.orElseSucceed((): RuntimeSnapshot | null => null))
						: Effect.succeed(null),
				],
				{ concurrency: "unbounded" },
			)
			view.report = report
			view.snapshot = snapshot
			yield* render
			surface.status({ refreshing: false, updatedAt: new Date() })
			yield* subscribe(snapshot)
		}).pipe(
			Effect.catch((error) =>
				Effect.sync(() => {
					surface.status({ refreshing: false })
					surface.notice(`Refresh failed: ${message(error)}`, "error")
				}),
			),
		)

		// Coalesce bursts of runtime events and key presses into one refresh,
		// and never refresh more often than the minimum interval.
		const minRefreshMs = options.minRefreshMs ?? MIN_REFRESH_MS
		yield* Effect.forkScoped(
			Effect.gen(function* () {
				let last = Number.NEGATIVE_INFINITY
				while (true) {
					yield* Queue.take(refreshes)
					yield* Effect.sleep(
						Math.max(DEBOUNCE_MS, last + minRefreshMs - Date.now()),
					)
					yield* Queue.clear(refreshes)
					last = Date.now()
					yield* refresh
				}
			}),
		)
		yield* Effect.forkScoped(
			Effect.gen(function* () {
				while (true) {
					yield* Effect.sleep((options.pollSeconds ?? 60) * 1000)
					requestRefresh()
				}
			}),
		)
		requestRefresh()

		const warnLog = (logError: string | null) => {
			if (logError) surface.notice(logError, "warning")
		}

		const confirmAndRun = (
			item: SuperviseItem,
			plan: Extract<
				Effect.Success<ReturnType<typeof executor.resolve>>,
				{ kind: "ready" }
			>["plan"],
			reason: string | null,
		) =>
			Effect.gen(function* () {
				const { action } = plan
				surface.notice(`Confirm ${action.title}`)
				const confirmation = yield* ask(() =>
					surface.confirm({
						title: action.title,
						rationale: reason
							? `${reason}. ${action.rationale}`
							: action.rationale,
						risk: action.risk,
						preview: plan.preview,
						destructive: plan.destructive,
					}),
				)
				const token = yield* executor
					.confirm(plan, confirmation, item.key, executorOptions)
					.pipe(Effect.option)
				if (token._tag === "None") {
					surface.notice(`Cancelled ${action.title}`, "warning")
					return null
				}
				surface.notice(`Running ${action.title}…`)
				const result = yield* executor.execute(
					token.value,
					item.key,
					executorOptions,
				)
				requestRefresh()
				if (result.outcome === "succeeded")
					surface.notice(
						`✓ ${action.title}${result.detail ? ` — ${result.detail}` : ""}`,
						"success",
					)
				else
					surface.notice(
						`${result.outcome === "skipped" ? "Skipped" : "Failed"}: ${action.title} — ${result.detail ?? "unknown error"}`,
						"error",
					)
				warnLog(result.logError)
				return result
			})

		const execute = (
			item: SuperviseItem,
			initial: SupervisorAction,
		): Effect.Effect<void, never, any> =>
			Effect.gen(function* () {
				let action = initial
				/** Why the current action replaced the one the user chose. */
				let reason: string | null = null
				const values: Record<string, string> = {}
				while (true) {
					surface.notice(`Preparing ${action.title}…`)
					const current = action
					const resolution = yield* executor
						.resolve(current, values, executorOptions)
						.pipe(
							Effect.tapError((error) =>
								Effect.flatMap(
									executor.record(
										current,
										item.key,
										"failed",
										error.message,
										env,
									),
									(logError) => Effect.sync(() => warnLog(logError)),
								),
							),
						)
					if (resolution.kind === "inputs") {
						for (const input of resolution.inputs) {
							const value = yield* ask(() =>
								surface.text(
									`${input.label}${input.required ? "" : " (optional; leave blank to skip)"}`,
								),
							)
							if (value === null || (input.required && !value.trim())) {
								warnLog(
									yield* executor.record(
										action,
										item.key,
										"cancelled",
										`No value for ${input.label}`,
										env,
									),
								)
								surface.notice(`Cancelled ${action.title}`, "warning")
								return
							}
							values[input.id] = value
						}
						continue
					}
					if (resolution.kind === "unavailable") {
						if (resolution.fallback) {
							// Resolve the fallback and show its real plan once.
							reason = resolution.reason
							action = resolution.fallback
							continue
						}
						surface.notice(
							`${action.title} is unavailable: ${resolution.reason}`,
							"warning",
						)
						return
					}
					const result: {
						readonly outcome: string
						readonly detail: string | null
						readonly fallback: SupervisorAction | null
					} | null = yield* confirmAndRun(item, resolution.plan, reason)
					if (!result?.fallback || result.outcome === "succeeded") return
					reason = result.detail ?? "The agent is unavailable"
					action = result.fallback
				}
			}).pipe(
				Effect.catch((error) =>
					Effect.sync(() => surface.notice(message(error), "error")),
				),
			)

		/** Focus through the executor, with the pane's identity rechecked. */
		const focus = (item: SuperviseItem) => {
			const existing = item.actions.find(
				(action) =>
					action.type === "runtime" &&
					action.payload.operation === "focus" &&
					action.payload.target === "pane",
			)
			const ref = item.subject.runtime[0]
			const pane = ref
				? view.snapshot?.panes.find(
						(candidate) => candidate.paneId === ref.paneId,
					)
				: undefined
			const action: SupervisorAction | null =
				existing ??
				(ref && pane
					? {
							version: 1,
							id: `${item.key}/focus-pane-${ref.paneId}`,
							type: "runtime",
							title: `Focus pane ${ref.paneId}`,
							rationale: "Look at the session.",
							risk: "reversible",
							subject: item.subject,
							preconditions: [
								{
									kind: "pane_matches",
									runtime: ref.runtime,
									paneId: pane.paneId,
									tabId: pane.tabId,
									cwd: pane.foregroundCwd ?? pane.cwd,
									agentSessionId: pane.agentSessionId,
									agentStatuses: [
										"idle",
										"working",
										"blocked",
										"done",
										"unknown",
									],
								},
							],
							payload: {
								runtime: ref.runtime,
								operation: "focus",
								target: "pane",
								id: ref.paneId,
							},
						}
					: null)
			if (!action) {
				surface.notice("This item has no pane to focus", "warning")
				return Effect.void
			}
			// `f` is itself the explicit, single confirmation of a reversible focus.
			return Effect.gen(function* () {
				const resolution = yield* executor.resolve(action, {}, executorOptions)
				if (resolution.kind !== "ready") {
					surface.notice(`Cannot focus: ${action.title}`, "warning")
					return
				}
				const token = yield* executor.confirm(
					resolution.plan,
					{ confirmed: true, destructiveConfirmed: false },
					item.key,
					executorOptions,
				)
				const result = yield* executor.execute(token, item.key, executorOptions)
				surface.notice(
					result.outcome === "succeeded"
						? (result.detail ?? action.title)
						: `Not focused — ${result.detail}`,
					result.outcome === "succeeded" ? "info" : "error",
				)
				warnLog(result.logError)
			}).pipe(
				Effect.catch((error) =>
					Effect.sync(() => surface.notice(message(error), "error")),
				),
			)
		}

		const editPrompt = (item: SuperviseItem | null) =>
			Effect.gen(function* () {
				const root =
					item && item.groupKey !== UNMANAGED_GROUP
						? item.groupKey
						: (view.report?.workbases.find((workbase) => !workbase.error)
								?.root ?? null)
				if (!root) {
					surface.notice("No workbase to edit a prompt for", "warning")
					return
				}
				const path = supervisionPromptPath(root)
				yield* fs.createDirectory(dirname(path))
				const editor = (env.VISUAL || env.EDITOR || "vi")
					.split(/\s+/)
					.filter(Boolean)
				const read = fs.readFile(path).pipe(Effect.orElseSucceed(() => null))
				const before = yield* read
				surface.suspend()
				const result = yield* fs
					.runCommand([...editor, path], { cwd: root, passthrough: true })
					.pipe(Effect.ensuring(Effect.sync(() => surface.resume())))
				if (result.exitCode !== 0) {
					surface.notice(
						`${editor[0]} exited with code ${result.exitCode}`,
						"warning",
					)
					return
				}
				const after = yield* read
				surface.notice(
					after === before ? `No changes to ${path}` : `Saved ${path}`,
					after === before ? "info" : "success",
				)
			}).pipe(
				Effect.catch((error) =>
					Effect.sync(() => surface.notice(message(error), "error")),
				),
			)

		const handle = (intent: Intent) => {
			switch (intent.kind) {
				case "execute":
					return execute(intent.item, intent.action)
				case "focus":
					return focus(intent.item)
				case "edit":
					return editPrompt(intent.item)
				case "snooze":
					return Effect.gen(function* () {
						const choice = yield* ask(() =>
							surface.choose(`Snooze ${intent.item.label} for`, SNOOZES),
						)
						if (choice === null) return
						yield* stateService.snooze(
							{
								key: intent.item.key,
								actionId: null,
								until: new Date(Date.now() + Number(choice)).toISOString(),
								reason: null,
							},
							env,
						)
						yield* render
						surface.notice(
							`Snoozed ${intent.item.label} for ${SNOOZES.find((item) => item.key === choice)?.label}`,
						)
					}).pipe(
						Effect.catch((error) =>
							Effect.sync(() => surface.notice(message(error), "error")),
						),
					)
				case "dismiss":
					return Effect.gen(function* () {
						yield* stateService.dismiss(
							{
								key: intent.item.key,
								actionId: null,
								fingerprint: intent.item.fingerprint,
								reason: null,
							},
							env,
						)
						yield* render
						surface.notice(`Dismissed ${intent.item.label} until it changes`)
					}).pipe(
						Effect.catch((error) =>
							Effect.sync(() => surface.notice(message(error), "error")),
						),
					)
			}
		}

		while (true) {
			const intent = yield* Effect.raceFirst(
				Queue.take(intents),
				Effect.as(Deferred.await(quit), null),
			)
			if (intent === null) break
			yield* handle(intent).pipe(
				Effect.ensuring(
					Effect.sync(() => {
						pending = false
						surface.status({ busy: false })
					}),
				),
			)
		}
	}).pipe(Effect.scoped)

export const help = `
Usage: agency supervise [--workbase <selector>]

Open a long-lived supervisor that shows everything needing attention across
every registered workbase, grouped by workbase plus an Unmanaged group, and
runs a selected action with Enter. It refreshes on runtime (Herdr) events and
periodically for pull request and ticket changes.

Every action previews exactly what it runs, rechecks its preconditions against
fresh state, and is appended to the local action log. Destructive actions need
a second confirmation. Agency actions are re-resolved through agency act before
running; work launches in a new, unfocused tab. Snoozes and dismissals persist
in local supervision state. Press ? for keys.

Options:
  --workbase <selector>  Supervise only one registered workbase
`
