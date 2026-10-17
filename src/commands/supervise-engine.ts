import {
	Deferred,
	Effect,
	FiberHandle,
	Option,
	Queue,
	Schema,
	Stream,
} from "effect"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { SupervisorAction, type AttentionReport } from "../attention-schema"
import { FileSystemService } from "../services/FileSystemService"
import { RuntimeService } from "../services/RuntimeService"
import { SupervisionService } from "../services/SupervisionService"
import { SupervisionStateService } from "../services/SupervisionStateService"
import {
	SupervisorExecutor,
	type ActionSource,
	type ExecutorOptions,
} from "../services/SupervisorExecutor"
import { TriageService } from "../services/TriageService"
import { WorkbaseService } from "../services/WorkbaseService"
import type { TriageReportItem } from "../triage-schema"
import type { BaseCommandOptions } from "../utils/command"
import type { RuntimeSnapshot, RuntimeSubscription } from "../workbase/runtime"
import {
	superviseModel,
	UNMANAGED_GROUP,
	type SuperviseItem,
	type TriageEntry,
} from "../workbase/supervise-view"

type NoticeTone = "info" | "success" | "warning" | "error"

interface ConfirmRequest {
	/** Where the action came from; model-written actions are flagged. */
	readonly source?: ActionSource
	/** The directory the action runs in, when it has one. */
	readonly cwd?: string | null
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

/** The outcome of collecting an Agency action's inputs in the act wizard. */
export type CollectedInputs =
	| { readonly kind: "values"; readonly values: Record<string, string> }
	| { readonly kind: "cancelled" }
	| { readonly kind: "unavailable"; readonly reason: string }

/** The terminal surface the supervisor drives; the Supervise tab or a fake. */
interface SupervisorUi {
	readonly update: (model: ReturnType<typeof superviseModel>) => void
	readonly status: (status: {
		readonly live?: boolean
		readonly refreshing?: boolean
		readonly busy?: boolean
		readonly updatedAt?: Date | null
		readonly triage?: TriageStatus
	}) => void
	readonly notice: (text: string, tone?: NoticeTone) => void
	readonly confirm: (request: ConfirmRequest) => Promise<Confirmation>
	/**
	 * Collect an Agency action's inputs in the act wizard, prefilled from its
	 * selector and values. The wizard collects only; the executor runs.
	 */
	readonly collect: (
		action: Extract<SupervisorAction, { type: "agency" }>,
	) => Promise<CollectedInputs>
	/** An action ran (whatever its outcome); Agency state may have changed. */
	readonly executed?: () => void
	readonly choose: (
		prompt: string,
		choices: readonly { readonly key: string; readonly label: string }[],
	) => Promise<string | null>
	readonly suspend: () => void
	readonly resume: () => void
	readonly close: () => Promise<void>
}

interface TriageStatus {
	/** What is being triaged, or null when idle. */
	readonly running: string | null
	readonly startedAt: Date | null
	/** The last run's outcome. */
	readonly last: string | null
}

interface SupervisorUiHandlers {
	readonly onExecute: (item: SuperviseItem, action: SupervisorAction) => void
	readonly onFocus: (item: SuperviseItem) => void
	readonly onRefresh: () => void
	/** Triage one item, or everything when null, then refresh. */
	readonly onTriage: (item: SuperviseItem | null) => void
	readonly onEditPrompt: (item: SuperviseItem | null) => void
	readonly onSnooze: (item: SuperviseItem) => void
	readonly onDismiss: (item: SuperviseItem) => void
	readonly onQuit: () => void
}

type OpenSupervisorUi = (
	handlers: SupervisorUiHandlers,
) => Promise<SupervisorUi>

export interface SuperviseOptions extends BaseCommandOptions {
	readonly workbase?: string
	readonly configDirectory?: string
	readonly env?: NodeJS.ProcessEnv
	/** The argv that runs this Agency CLI for re-resolved agency actions. */
	readonly agencyCommand?: readonly string[]
	/** Seconds between full refreshes without runtime events. */
	readonly pollSeconds?: number
	/** Minimum milliseconds between refreshes. */
	readonly minRefreshMs?: number
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

/** The prompt file `e` creates when a workbase names none. */
const DEFAULT_PROMPT_FILE = "triage.md"

const decodeAction = Schema.decodeUnknownOption(SupervisorAction)

/**
 * Validate every triage-sourced action against the action schema; invalid
 * ones are dropped (and counted) rather than shown or executed.
 */
const decodeTriageEntry = (
	entry: TriageEntry,
): { readonly entry: TriageEntry; readonly dropped: number } => {
	const assessment = entry.assessment
	if (!assessment) return { entry, dropped: 0 }
	const actions = assessment.actions.flatMap((action) =>
		Option.toArray(decodeAction(action)),
	)
	const kept = new Set(actions.map((action) => action.id))
	return {
		entry: {
			...entry,
			assessment: {
				...assessment,
				actions,
				modelActionIds: assessment.modelActionIds.filter((id) => kept.has(id)),
			},
		},
		dropped: assessment.actions.length - actions.length,
	}
}

const elapsed = (since: Date) => {
	const seconds = Math.round((Date.now() - since.getTime()) / 1000)
	return seconds < 60
		? `${seconds}s`
		: `${Math.floor(seconds / 60)}m${seconds % 60}s`
}

/** The directory an Agency or command action runs in, if it names one. */
const actionCwd = (action: SupervisorAction) =>
	action.type === "agency" || action.type === "command"
		? action.payload.cwd
		: null

const within = (root: string, path: string) => {
	const local = relative(resolve(root), resolve(path))
	return !local || (!local.startsWith("..") && !isAbsolute(local))
}

const defaultAgencyCommand = () =>
	process.argv[1] ? [process.execPath, process.argv[1]] : ["agency"]

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

/**
 * Run the supervisor behind the Supervise tab until it quits: refresh on
 * runtime events, triage, and execute one confirmed action at a time.
 */
export const runSupervisor = (
	options: SuperviseOptions,
	openUi: OpenSupervisorUi,
) =>
	Effect.gen(function* () {
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
		let startTriage: (item: SuperviseItem | null) => void = () => {}
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
						onTriage: (item) => startTriage(item),
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
			/** Results of triage runs in this session, by item key. */
			triage: Map<string, TriageReportItem>
			dropped: number
		} = {
			report: null,
			snapshot: null,
			subscriptionKey: null,
			triage: new Map(),
			dropped: 0,
		}

		/** Cached assessments, overlaid by this session's newer run results. */
		const triageEntries = Effect.gen(function* () {
			const entries = new Map<string, TriageEntry>()
			for (const cached of yield* stateService.triageCache(env))
				entries.set(cached.key, {
					key: cached.key,
					subject: null,
					fingerprint: cached.fingerprint,
					source: "cached",
					evaluatedAt: cached.evaluatedAt,
					assessment: cached.assessment,
					suppressed: null,
					error: null,
				})
			for (const item of view.triage.values()) {
				const cached = entries.get(item.key)
				if (
					cached?.evaluatedAt &&
					item.evaluatedAt &&
					cached.evaluatedAt > item.evaluatedAt
				)
					entries.set(item.key, { ...cached, subject: item.subject })
				else entries.set(item.key, item)
			}
			let dropped = 0
			const decoded = new Map<string, TriageEntry>()
			for (const [key, entry] of entries) {
				const result = decodeTriageEntry(entry)
				dropped += result.dropped
				decoded.set(key, result.entry)
			}
			return { entries: decoded, dropped }
		})

		const render = Effect.gen(function* () {
			if (!view.report) return
			const [snoozes, dismissals, triage] = yield* Effect.all([
				stateService.snoozes(env),
				stateService.dismissals(env),
				triageEntries,
			])
			if (triage.dropped > view.dropped)
				surface.notice(
					`Ignored ${triage.dropped} triage action(s) that failed the action schema`,
					"warning",
				)
			view.dropped = triage.dropped
			surface.update(
				superviseModel(view.report, {
					snapshot: view.snapshot,
					state: { snoozes, dismissals },
					triage: triage.entries,
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

		// One triage run at a time, in the background so the view stays live.
		const triageService = yield* TriageService
		const triageRequests = yield* Queue.dropping<SuperviseItem | null>(1)
		let triaging = false
		let lastTriage: string | null = null
		startTriage = (item) => {
			if (triaging) {
				surface.notice("Triage is already running", "warning")
				return
			}
			triaging = true
			Queue.offerUnsafe(triageRequests, item)
		}
		const runTriage = (item: SuperviseItem | null) => {
			const label = item ? item.label : "everything"
			const startedAt = new Date()
			surface.status({
				triage: { running: label, startedAt, last: lastTriage },
			})
			surface.notice(
				item
					? `Triaging ${label}…`
					: "Triaging everything; a full run can take minutes…",
			)
			return Effect.gen(function* () {
				const report = yield* triageService.triage({
					workbase: options.workbase,
					cwd: options.cwd,
					configDirectory: options.configDirectory,
					env,
					...(item ? { item: item.key } : {}),
				})
				if (!item) view.triage.clear()
				for (const entry of report.items) view.triage.set(entry.key, entry)
				const { fresh, cached, stale, failed } = report.summary
				lastTriage = `${item ? label : "full"} at ${startedAt.toLocaleTimeString()}: ${fresh} fresh, ${cached} cached${stale ? `, ${stale} stale` : ""}${failed ? `, ${failed} failed` : ""}`
				surface.notice(
					report.failures.length
						? `Triage finished with ${report.failures.length} failure(s): ${report.failures[0]!.message}`
						: `Triage finished in ${elapsed(startedAt)}`,
					report.failures.length ? "warning" : "success",
				)
				yield* render
				requestRefresh()
			}).pipe(
				Effect.catch((error) =>
					Effect.sync(() => {
						lastTriage = `${label} failed at ${startedAt.toLocaleTimeString()}`
						surface.notice(`Triage failed: ${message(error)}`, "error")
					}),
				),
				Effect.ensuring(
					Effect.sync(() => {
						triaging = false
						surface.status({
							triage: { running: null, startedAt: null, last: lastTriage },
						})
					}),
				),
			)
		}
		yield* Effect.forkScoped(
			Effect.gen(function* () {
				while (true) yield* runTriage(yield* Queue.take(triageRequests))
			}),
		)

		const sourceOf = (
			item: SuperviseItem,
			action: SupervisorAction,
		): ActionSource =>
			item.modelActionIds.includes(action.id)
				? "model"
				: item.triageActionIds.includes(action.id)
					? "triage"
					: "signal"

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
			source: ActionSource,
		) =>
			Effect.gen(function* () {
				const { action } = plan
				surface.notice(`Confirm ${action.title}`)
				const confirmation = yield* ask(() =>
					surface.confirm({
						source,
						cwd: actionCwd(action),
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
				surface.executed?.()
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
				// Fallbacks are generated by the executor, not by triage.
				let source = sourceOf(item, initial)
				/** Why the current action replaced the one the user chose. */
				let reason: string | null = null
				while (true) {
					const current = action
					let values: Record<string, string> = {}
					// A model can write any cwd: run only inside a workbase that is
					// registered or the current one, never one seen only in a pane.
					const cwd = actionCwd(current)
					if (
						cwd !== null &&
						!(view.report?.workbases ?? []).some(
							(workbase) =>
								workbase.available &&
								workbase.source !== "runtime" &&
								within(workbase.root, cwd),
						)
					) {
						const reason = `${cwd} is not inside a supervised workbase`
						warnLog(
							yield* executor.record(current, item.key, "failed", reason, env),
						)
						surface.notice(
							`${current.title} is unavailable: ${reason}`,
							"error",
						)
						return
					}
					// Agency actions collect their inputs in the act wizard; the
					// executor still re-resolves, previews, confirms, and runs them.
					if (current.type === "agency") {
						surface.notice(`Opening ${current.title} in the act wizard…`)
						const collected = yield* ask(() => surface.collect(current))
						if (collected.kind === "cancelled") {
							warnLog(
								yield* executor.record(
									current,
									item.key,
									"cancelled",
									"Cancelled in the act wizard",
									env,
								),
							)
							surface.notice(`Cancelled ${current.title}`, "warning")
							return
						}
						if (collected.kind === "unavailable") {
							surface.notice(
								`${current.title} is unavailable: ${collected.reason}`,
								"warning",
							)
							return
						}
						values = collected.values
					}
					surface.notice(`Preparing ${action.title}…`)
					const resolution = yield* executor
						.resolve(current, values, executorOptions, source)
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
						// The wizard and the discovered action disagree; never guess.
						const missing = resolution.inputs
							.map((input) => input.label)
							.join(", ")
						warnLog(
							yield* executor.record(
								action,
								item.key,
								"failed",
								`The act wizard did not collect: ${missing}`,
								env,
							),
						)
						surface.notice(
							`${action.title} is unavailable: the act wizard did not collect ${missing}`,
							"error",
						)
						return
					}
					if (resolution.kind === "unavailable") {
						if (resolution.fallback) {
							// Resolve the fallback and show its real plan once.
							reason = resolution.reason
							action = resolution.fallback
							source = "signal"
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
					} | null = yield* confirmAndRun(item, resolution.plan, reason, source)
					if (!result?.fallback || result.outcome === "succeeded") return
					reason = result.detail ?? "The agent is unavailable"
					action = result.fallback
					source = "signal"
				}
			}).pipe(
				Effect.catch((error) =>
					Effect.sync(() => surface.notice(message(error), "error")),
				),
			)

		/** Focus through the executor, with the pane's identity rechecked. */
		const focus = (item: SuperviseItem) => {
			const focusActions = item.actions.filter(
				(action) =>
					action.type === "runtime" &&
					action.payload.operation === "focus" &&
					action.payload.target === "pane",
			)
			const existing =
				focusActions.find(
					(action) => !item.modelActionIds.includes(action.id),
				) ?? focusActions[0]
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
				const resolution = yield* executor.resolve(
					action,
					{},
					executorOptions,
					sourceOf(item, action),
				)
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

		/**
		 * Edit the workbase's triage prompt file: `triage.promptFile` when set,
		 * otherwise `triage.md` beside agency.json, which is then recorded as
		 * `triage.promptFile` (after confirmation) so triage reads it.
		 */
		const editPrompt = (item: SuperviseItem | null) =>
			Effect.gen(function* () {
				const workbases = yield* WorkbaseService
				const root =
					item && item.groupKey !== UNMANAGED_GROUP
						? item.groupKey
						: (view.report?.workbases.find((workbase) => !workbase.error)
								?.root ?? null)
				if (!root) {
					surface.notice("No workbase to edit a prompt for", "warning")
					return
				}
				const loaded = yield* workbases.loadConfig(root)
				const configText = yield* fs.readFile(join(loaded.root, "agency.json"))
				const configured = loaded.config.triage?.promptFile
				const file = configured ?? DEFAULT_PROMPT_FILE
				const path = isAbsolute(file) ? file : resolve(loaded.root, file)
				yield* fs.createDirectory(dirname(path))
				const editor = (env.VISUAL || env.EDITOR || "vi")
					.split(/\s+/)
					.filter(Boolean)
				const read = fs.readFile(path).pipe(Effect.orElseSucceed(() => null))
				const before = yield* read
				surface.suspend()
				const result = yield* fs
					.runCommand([...editor, path], {
						cwd: loaded.root,
						passthrough: true,
					})
					.pipe(Effect.ensuring(Effect.sync(() => surface.resume())))
				if (result.exitCode !== 0) {
					surface.notice(
						`${editor[0]} exited with code ${result.exitCode}`,
						"warning",
					)
					return
				}
				const after = yield* read
				if (configured || !after?.trim()) {
					surface.notice(
						after === before ? `No changes to ${path}` : `Saved ${path}`,
						after === before ? "info" : "success",
					)
					return
				}
				const confirmation = yield* ask(() =>
					surface.confirm({
						title: `Use ${file} as this workbase's triage prompt`,
						rationale: `Triage reads only triage.promptFile${loaded.config.triage?.prompt ? " (after the inline triage.prompt, which is kept)" : ""}; record it in agency.json.`,
						risk: "reversible",
						preview: [
							`Set "triage": { "promptFile": "${file}" } in ${join(loaded.root, "agency.json")}`,
						],
						destructive: false,
					}),
				)
				if (!confirmation.confirmed) {
					surface.notice(
						`Saved ${path}, but triage will not read it until triage.promptFile names it`,
						"warning",
					)
					return
				}
				yield* workbases.setTriagePromptFile(loaded.root, file, configText)
				surface.notice(`Saved ${path} and set triage.promptFile`, "success")
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
