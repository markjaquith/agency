import { Effect, FiberHandle, Queue, Stream } from "effect"
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
	readonly confirm: (request: {
		readonly title: string
		readonly rationale: string
		readonly risk: SupervisorAction["risk"]
		readonly preview: readonly string[]
		readonly destructive: boolean
	}) => Promise<boolean>
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

export type OpenSupervisorUi = (
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
	| { readonly kind: "quit" }

const SNOOZES = [
	{ key: "3600000", label: "1 hour" },
	{ key: "14400000", label: "4 hours" },
	{ key: "86400000", label: "1 day" },
	{ key: "604800000", label: "1 week" },
] as const

const DEBOUNCE_MS = 400
const RESUBSCRIBE_MS = 5_000

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
		const intents = yield* Queue.unbounded<Intent>()
		const refreshes = yield* Queue.sliding<true>(1)
		const requestRefresh = () => {
			Queue.offerUnsafe(refreshes, true)
		}
		const offer = (intent: Intent) => {
			Queue.offerUnsafe(intents, intent)
		}
		const ui = yield* Effect.acquireRelease(
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
						onQuit: () => offer({ kind: "quit" }),
					}),
				catch: (cause) => new Error("Unable to open the supervisor", { cause }),
			}),
			(ui) => Effect.promise(() => ui.close()),
		)
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
			ui.update(
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
							ui.status({ live: true })
							yield* runtime.subscribe(wanted).pipe(
								Stream.runForEach(() => Effect.sync(requestRefresh)),
								Effect.catch(() => Effect.void),
							)
							ui.status({ live: false })
							yield* Effect.sleep(RESUBSCRIBE_MS)
						}
					}),
				)
			})

		const refresh = Effect.gen(function* () {
			ui.status({ refreshing: true })
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
			ui.status({ refreshing: false, updatedAt: new Date() })
			yield* subscribe(snapshot)
		}).pipe(
			Effect.catch((error) =>
				Effect.sync(() => {
					ui.status({ refreshing: false })
					ui.notice(`Refresh failed: ${message(error)}`, "error")
				}),
			),
		)

		// Coalesce bursts of runtime events and key presses into one refresh.
		yield* Effect.forkScoped(
			Effect.gen(function* () {
				while (true) {
					yield* Queue.take(refreshes)
					yield* Effect.sleep(DEBOUNCE_MS)
					yield* Queue.clear(refreshes)
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

		const execute = (
			item: SuperviseItem,
			initial: SupervisorAction,
		): Effect.Effect<void, never, any> =>
			Effect.gen(function* () {
				let action = initial
				const values: Record<string, string> = {}
				while (true) {
					ui.notice(`Preparing ${action.title}…`)
					const resolution = yield* executor.resolve(
						action,
						values,
						executorOptions,
					)
					if (resolution.kind === "inputs") {
						for (const input of resolution.inputs) {
							const value = yield* ask(() =>
								ui.text(
									`${input.label}${input.required ? "" : " (optional; leave blank to skip)"}`,
								),
							)
							if (value === null || (input.required && !value.trim())) {
								yield* executor.record(
									action,
									item.key,
									"cancelled",
									`No value for ${input.label}`,
									env,
								)
								ui.notice(`Cancelled ${action.title}`, "warning")
								return
							}
							values[input.id] = value
						}
						continue
					}
					if (resolution.kind === "unavailable") {
						if (resolution.fallback) {
							const accepted = yield* ask(() =>
								ui.confirm({
									title: resolution.fallback!.title,
									rationale: `${resolution.reason}. ${resolution.fallback!.rationale}`,
									risk: resolution.fallback!.risk,
									preview: ["Resolve the delegation to see exactly what runs."],
									destructive: false,
								}),
							)
							if (accepted) {
								action = resolution.fallback
								continue
							}
						}
						ui.notice(
							`${action.title} is unavailable: ${resolution.reason}`,
							"warning",
						)
						return
					}
					const { plan } = resolution
					ui.notice(`Confirm ${action.title}`)
					const confirmed = yield* ask(() =>
						ui.confirm({
							title: action.title,
							rationale: action.rationale,
							risk: action.risk,
							preview: plan.preview,
							destructive: plan.destructive,
						}),
					)
					if (!confirmed) {
						yield* executor.record(
							action,
							item.key,
							"cancelled",
							"Declined at confirmation",
							env,
						)
						ui.notice(`Cancelled ${action.title}`, "warning")
						return
					}
					ui.notice(`Running ${action.title}…`)
					const result = yield* executor.execute(
						plan,
						item.key,
						executorOptions,
					)
					requestRefresh()
					if (result.outcome === "succeeded") {
						ui.notice(
							`✓ ${action.title}${result.detail ? ` — ${result.detail}` : ""}`,
							"success",
						)
						return
					}
					ui.notice(
						`${result.outcome === "skipped" ? "Skipped" : "Failed"}: ${action.title} — ${result.detail ?? "unknown error"}`,
						"error",
					)
					if (!result.fallback) return
					const delegate = yield* ask(() =>
						ui.confirm({
							title: result.fallback!.title,
							rationale: `${result.detail ?? "The agent is unavailable"}. ${result.fallback!.rationale}`,
							risk: result.fallback!.risk,
							preview: ["Resolve the delegation to see exactly what runs."],
							destructive: false,
						}),
					)
					if (!delegate) return
					action = result.fallback
				}
			}).pipe(
				Effect.catch((error) =>
					Effect.sync(() => ui.notice(message(error), "error")),
				),
			)

		const editPrompt = (item: SuperviseItem | null) =>
			Effect.gen(function* () {
				const root =
					item && item.groupKey !== UNMANAGED_GROUP
						? item.groupKey
						: (view.report?.workbases.find((workbase) => !workbase.error)
								?.root ?? null)
				if (!root) {
					ui.notice("No workbase to edit a prompt for", "warning")
					return
				}
				const path = supervisionPromptPath(root)
				yield* fs.createDirectory(dirname(path))
				const editor = (env.VISUAL || env.EDITOR || "vi")
					.split(/\s+/)
					.filter(Boolean)
				const read = fs.readFile(path).pipe(Effect.orElseSucceed(() => null))
				const before = yield* read
				ui.suspend()
				const result = yield* fs
					.runCommand([...editor, path], { cwd: root, passthrough: true })
					.pipe(Effect.ensuring(Effect.sync(() => ui.resume())))
				if (result.exitCode !== 0) {
					ui.notice(
						`${editor[0]} exited with code ${result.exitCode}`,
						"warning",
					)
					return
				}
				const after = yield* read
				ui.notice(
					after === before ? `No changes to ${path}` : `Saved ${path}`,
					after === before ? "info" : "success",
				)
			}).pipe(
				Effect.catch((error) =>
					Effect.sync(() => ui.notice(message(error), "error")),
				),
			)

		const handle = (intent: Exclude<Intent, { kind: "quit" }>) => {
			switch (intent.kind) {
				case "execute":
					return execute(intent.item, intent.action)
				case "focus":
					return Effect.gen(function* () {
						const pane = intent.item.subject.runtime[0]
						const runtime = yield* provider
						if (!pane || !runtime) {
							ui.notice("This item has no pane to focus", "warning")
							return
						}
						yield* runtime.focus("pane", pane.paneId)
						ui.notice(`Focused pane ${pane.paneId}`)
					}).pipe(
						Effect.catch((error) =>
							Effect.sync(() => ui.notice(message(error), "error")),
						),
					)
				case "edit":
					return editPrompt(intent.item)
				case "snooze":
					return Effect.gen(function* () {
						const choice = yield* ask(() =>
							ui.choose(`Snooze ${intent.item.label} for`, SNOOZES),
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
						ui.notice(
							`Snoozed ${intent.item.label} for ${SNOOZES.find((item) => item.key === choice)?.label}`,
						)
					}).pipe(
						Effect.catch((error) =>
							Effect.sync(() => ui.notice(message(error), "error")),
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
						ui.notice(`Dismissed ${intent.item.label} until it changes`)
					}).pipe(
						Effect.catch((error) =>
							Effect.sync(() => ui.notice(message(error), "error")),
						),
					)
			}
		}

		while (true) {
			const intent = yield* Queue.take(intents)
			if (intent.kind === "quit") break
			ui.status({ busy: true })
			yield* handle(intent)
			ui.status({ busy: false })
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
