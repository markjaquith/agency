import { Context, Data, Effect, Layer, Result } from "effect"
import { homedir, tmpdir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import actionSchema from "../../schemas/agency-action-v1.schema.json"
import triageSchema from "../../schemas/agency-triage-v1.schema.json"
import {
	TRIAGE_VERSION,
	type TriageAssessment,
	type TriageFailure,
	type TriageReport,
	type TriageReportItem,
} from "../triage-schema"
import {
	boundTranscript,
	chunk,
	digest,
	itemFingerprint,
	itemSnapshot,
	matchesItem,
	retryMessage,
	TRANSCRIPT_LINES,
	triageItems,
	triageMessage,
	validateResponse,
	waitingPanes,
	workbaseRef,
	type PromptSection,
	type TranscriptTail,
	type TriageItem,
} from "../workbase/triage"
import {
	CARRIED_SETTINGS,
	TRIAGE_AGENT,
	triageAgentConfig,
	triageProfile,
} from "../workbase/triage-contract"
import type { AttentionWorkbase } from "../workbase/attention"
import { FileSystemService } from "./FileSystemService"
import { RuntimeService } from "./RuntimeService"
import {
	SupervisionService,
	type SupervisionOptions,
} from "./SupervisionService"
import {
	SupervisionStateService,
	type TriageCacheEntry,
} from "./SupervisionStateService"
import { globalConfigPath, WorkbaseService } from "./WorkbaseService"

class TriageError extends Data.TaggedError("TriageError")<{
	readonly message: string
}> {}

const BATCH_CONCURRENCY = 2
const TRANSCRIPT_CONCURRENCY = 8
const RUN_TIMEOUT_MS = 10 * 60_000
/** Recent supervisor actions per item, sent to the agent and fingerprinted. */
const ITEM_ACTIONS = 20
/** Items per OpenCode run, bounding prompt size. */
const BATCH_ITEMS = 8

/**
 * The child environment: no Agency worker identity, no inherited OpenCode
 * settings or session, and no Herdr location, so the run cannot act as (or
 * report into) the invoking session. OpenCode reads only the run's own config
 * directory and locates its project from $PWD.
 */
const triageEnvironment = (
	env: NodeJS.ProcessEnv,
	paths: { readonly directory: string; readonly configDirectory: string },
): Record<string, string> => ({
	...Object.fromEntries(
		Object.entries(env).filter(
			(entry): entry is [string, string] =>
				entry[1] !== undefined &&
				!/^(AGENCY_|OPENCODE_)/.test(entry[0]) &&
				!["HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID"].includes(
					entry[0],
				),
		),
	),
	PWD: paths.directory,
	OPENCODE_CONFIG_DIR: paths.configDirectory,
	OPENCODE_DISABLE_PROJECT_CONFIG: "1",
	OPENCODE_DISABLE_CLAUDE_CODE: "1",
	OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
	OPENCODE_DISABLE_AUTOUPDATE: "1",
})

interface TriageOptions extends SupervisionOptions {
	/** Re-evaluate only the item with this key, unit, task[/phase], or pane. */
	readonly item?: string
}

interface RunnerResult {
	readonly sessionId: string | null
	readonly text: string | null
	readonly error: string | null
}

interface Batch {
	readonly workbase: AttentionWorkbase | null
	readonly items: readonly TriageItem[]
}

type BatchOutcome =
	| {
			readonly ok: true
			readonly assessments: ReadonlyMap<string, TriageAssessment>
	  }
	| { readonly ok: false; readonly failure: TriageFailure }

const OpenCodeEvent = (line: string) => {
	try {
		const value: unknown = JSON.parse(line)
		return typeof value === "object" && value !== null
			? (value as Record<string, any>)
			: null
	} catch {
		return null
	}
}

/** The final reply and session from `opencode run --format json` output. */
const parseRunOutput = (stdout: string) => {
	let sessionId: string | null = null
	const errors: string[] = []
	const texts = new Map<string, string[]>()
	let last: string | null = null
	for (const line of stdout.split("\n")) {
		const event = line.trim() ? OpenCodeEvent(line) : null
		if (!event) continue
		if (typeof event.sessionID === "string") sessionId ??= event.sessionID
		if (event.type === "error")
			errors.push(
				typeof event.error?.message === "string"
					? event.error.message
					: JSON.stringify(event.error ?? event),
			)
		if (event.type === "text" && typeof event.part?.text === "string") {
			const message = String(event.part.messageID ?? "")
			texts.set(message, [...(texts.get(message) ?? []), event.part.text])
			last = message
		}
	}
	return {
		sessionId,
		error: errors.length ? errors.join("\n") : null,
		text: last === null ? null : texts.get(last)!.join(""),
	}
}

export class TriageService extends Context.Service<TriageService>()(
	"TriageService",
	{
		make: Effect.sync(() => {
			const readPrompt = (
				config: { readonly prompt?: string; readonly promptFile?: string },
				base: string,
			) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const parts = config.prompt ? [config.prompt] : []
					if (config.promptFile) {
						const path = isAbsolute(config.promptFile)
							? config.promptFile
							: resolve(base, config.promptFile)
						parts.push(
							yield* fs.readFile(path).pipe(
								Effect.mapError(
									() =>
										new TriageError({
											message: `Cannot read triage prompt file ${path}`,
										}),
								),
							),
						)
					}
					return parts
						.map((part) => part.trim())
						.filter(Boolean)
						.join("\n\n")
				})

			const transcripts = (
				items: readonly TriageItem[],
				env: NodeJS.ProcessEnv | undefined,
			) =>
				Effect.gen(function* () {
					const runtime = yield* RuntimeService
					const provider = yield* runtime.provider(env)
					const tails = new Map<string, TranscriptTail[]>()
					if (!provider) return tails
					const panes = [
						...new Set(items.flatMap((item) => waitingPanes(item))),
					]
					const texts = new Map(
						yield* Effect.forEach(
							panes,
							(pane) =>
								provider
									.readTranscript(pane.paneId, { lines: TRANSCRIPT_LINES })
									.pipe(
										Effect.map(
											(text) => [pane.paneId, boundTranscript(text)] as const,
										),
										Effect.orElseSucceed(() => [pane.paneId, ""] as const),
									),
							{ concurrency: TRANSCRIPT_CONCURRENCY },
						),
					)
					for (const item of items) {
						tails.set(
							item.key,
							waitingPanes(item).flatMap((pane) => {
								const text = texts.get(pane.paneId)
								return text ? [{ paneId: pane.paneId, text }] : []
							}),
						)
					}
					return tails
				})

			/** Model and provider settings from the user's own OpenCode config. */
			const carriedSettings = (env: NodeJS.ProcessEnv) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const directory =
						env.OPENCODE_CONFIG_DIR ||
						join(
							env.XDG_CONFIG_HOME || join(env.HOME ?? homedir(), ".config"),
							"opencode",
						)
					for (const name of ["opencode.jsonc", "opencode.json"]) {
						const content = yield* fs
							.readFile(join(directory, name))
							.pipe(Effect.orElseSucceed(() => null))
						if (content === null) continue
						let parsed: unknown
						try {
							parsed = Bun.JSONC.parse(content)
						} catch {
							return {}
						}
						if (typeof parsed !== "object" || parsed === null) return {}
						return Object.fromEntries(
							CARRIED_SETTINGS.flatMap((key) =>
								key in parsed ? [[key, (parsed as any)[key]]] : [],
							),
						)
					}
					return {}
				})

			const runOpenCode = (input: {
				readonly directory: string
				readonly configDirectory: string
				readonly message: string
				readonly files: readonly string[]
				readonly sessionId: string | null
				readonly model: string | undefined
				readonly env: NodeJS.ProcessEnv
			}) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const argv = [
						input.env.AGENCY_OPENCODE_BIN || "opencode",
						"run",
						"--standalone",
						"--agent",
						TRIAGE_AGENT,
						"--format",
						"json",
						"--title",
						"Agency triage",
						...(input.model ? ["--model", input.model] : []),
						...(input.sessionId ? ["--session", input.sessionId] : []),
						...input.files.flatMap((file) => ["--file", file]),
						input.message,
					]
					const result = yield* fs
						.runCommand(argv, {
							cwd: input.directory,
							captureOutput: true,
							ignoreStdin: true,
							timeoutMs: RUN_TIMEOUT_MS,
							replaceEnv: true,
							env: triageEnvironment(input.env, {
								directory: input.directory,
								configDirectory: input.configDirectory,
							}),
						})
						.pipe(Effect.result)
					if (Result.isFailure(result))
						return {
							sessionId: input.sessionId,
							text: null,
							error: result.failure.message,
						} satisfies RunnerResult
					const parsed = parseRunOutput(result.success.stdout)
					const error =
						parsed.error ??
						(result.success.exitCode !== 0
							? result.success.stderr ||
								`opencode exited with code ${result.success.exitCode}`
							: parsed.text === null
								? "opencode returned no reply"
								: null)
					return {
						sessionId: parsed.sessionId ?? input.sessionId,
						text: parsed.text,
						error,
					} satisfies RunnerResult
				})

			/** Run one batch of changed items, retrying once on invalid replies. */
			const runBatch = (
				batch: Batch,
				input: {
					readonly message: string
					readonly snapshot: unknown
					readonly settings: Readonly<Record<string, unknown>>
					readonly model: string | undefined
					readonly env: NodeJS.ProcessEnv
				},
			) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const keys = batch.items.map((item) => item.key)
					// Each run is an isolated OpenCode project outside $HOME, with its
					// own config directory instead of the user's global one.
					const base = yield* fs
						.realPath(tmpdir())
						.pipe(Effect.orElseSucceed(() => tmpdir()))
					const run = join(
						base,
						`agency-triage-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
					)
					const configDirectory = join(run, ".config")
					const files = {
						snapshot: join(run, "snapshot.json"),
						triage: join(run, "agency-triage-v1.schema.json"),
						action: join(run, "agency-action-v1.schema.json"),
					}
					const failure = (
						kind: TriageFailure["kind"],
						message: string,
						errors: readonly string[],
						attempts: number,
						sessionId: string | null,
					): BatchOutcome => ({
						ok: false,
						failure: {
							workbase: workbaseRef(batch.workbase),
							keys,
							kind,
							message,
							errors,
							attempts,
							sessionId,
						},
					})
					const attempt = (
						message: string,
						sessionId: string | null,
						attempts: number,
					): Effect.Effect<BatchOutcome, never, FileSystemService> =>
						Effect.gen(function* () {
							const result = yield* runOpenCode({
								directory: run,
								configDirectory,
								message,
								files: sessionId
									? []
									: [files.snapshot, files.triage, files.action],
								sessionId,
								model: input.model,
								env: input.env,
							})
							if (result.error !== null || result.text === null)
								return failure(
									"runner",
									result.error ?? "opencode returned no reply",
									[],
									attempts,
									result.sessionId,
								)
							const validated = validateResponse(result.text, batch.items)
							if (validated.ok)
								return { ok: true, assessments: validated.items }
							if (attempts === 1 && result.sessionId)
								return yield* attempt(
									retryMessage(validated.errors),
									result.sessionId,
									attempts + 1,
								)
							return failure(
								"invalid_response",
								"The triage reply did not satisfy the response contract",
								validated.errors,
								attempts,
								result.sessionId,
							)
						})
					return yield* Effect.gen(function* () {
						yield* fs.createDirectory(configDirectory)
						yield* fs.writeFileAtomic(
							join(configDirectory, "opencode.jsonc"),
							triageAgentConfig({
								readRoots: batch.workbase?.roots ?? [],
								settings: input.settings,
							}),
						)
						yield* fs.writeJSON(files.snapshot, input.snapshot)
						yield* fs.writeJSON(files.triage, triageSchema)
						yield* fs.writeJSON(files.action, actionSchema)
						return yield* attempt(input.message, null, 1)
					}).pipe(
						Effect.catch((error) =>
							Effect.succeed(failure("runner", error.message, [], 0, null)),
						),
						Effect.ensuring(fs.deleteDirectory(run).pipe(Effect.ignore)),
					)
				})

			const triage = (options: TriageOptions = {}) =>
				Effect.gen(function* () {
					const supervision = yield* SupervisionService
					const state = yield* SupervisionStateService
					const workbases = yield* WorkbaseService
					const env = options.env ?? process.env
					const { snapshot, report } = yield* supervision.inspect(options)
					let items = triageItems(snapshot, report.signals)
					if (options.item) {
						const selector = options.item
						items = items.filter((item) => matchesItem(item, selector))
						if (items.length === 0)
							return yield* new TriageError({
								message: `No supervised item matches '${selector}'`,
							})
						if (items.length > 1)
							return yield* new TriageError({
								message: `'${selector}' matches several items: ${items.map((item) => item.key).join(", ")}`,
							})
					}
					const full = options.item === undefined

					const global = yield* workbases.loadGlobalConfig(
						options.configDirectory,
					)
					const model = global.triage?.model
					const globalPrompt = global.triage
						? yield* readPrompt(
								global.triage,
								dirname(globalConfigPath(options.configDirectory)),
							)
						: ""
					const sections = new Map<string | null, PromptSection[]>()
					const sectionsFor = (workbase: AttentionWorkbase | null) =>
						Effect.gen(function* () {
							const root = workbase?.ref.root ?? null
							const cached = sections.get(root)
							if (cached) return cached
							const result: PromptSection[] = globalPrompt
								? [{ title: "Supervisor instructions", text: globalPrompt }]
								: []
							if (workbase && !workbase.error) {
								const loaded = yield* workbases.loadConfig(workbase.ref.root)
								const text = loaded.config.triage
									? yield* readPrompt(loaded.config.triage, loaded.root)
									: ""
								if (text)
									result.push({
										title: `Workbase instructions (${workbase.ref.name ?? workbase.ref.id ?? workbase.ref.root})`,
										text,
									})
							}
							sections.set(root, result)
							return result
						})

					const tails = yield* transcripts(items, options.env)
					const actionLog = yield* state.actions({}, options.env)
					const actionsFor = (key: string) =>
						actionLog.filter((entry) => entry.key === key).slice(-ITEM_ACTIONS)
					const fingerprints = new Map<string, string>()
					for (const item of items) {
						fingerprints.set(
							item.key,
							itemFingerprint(
								item,
								tails.get(item.key) ?? [],
								actionsFor(item.key),
								digest({
									prompts: yield* sectionsFor(item.workbase),
									model: model ?? null,
									profile: triageProfile,
								}),
							),
						)
					}
					const snoozes = yield* state.snoozes(options.env)
					const allDismissals = yield* state.dismissals(options.env)
					/** Dismissals that still apply: unconditional, or for this state. */
					const dismissalsFor = (key: string) =>
						allDismissals.filter(
							(entry) =>
								entry.key === key &&
								(entry.fingerprint === null ||
									entry.fingerprint === fingerprints.get(key)),
						)
					const snoozesFor = (key: string) =>
						snoozes.filter((entry) => entry.key === key)

					const cache = new Map(
						(yield* state.triageCache(options.env)).map((entry) => [
							entry.key,
							entry,
						]),
					)
					const changed = items.filter(
						(item) =>
							!full ||
							cache.get(item.key)?.fingerprint !== fingerprints.get(item.key),
					)
					const groups: Batch[] = []
					for (const item of changed) {
						const group = groups.find(
							(entry) => entry.workbase === item.workbase,
						)
						if (group) (group.items as TriageItem[]).push(item)
						else groups.push({ workbase: item.workbase, items: [item] })
					}
					const batches = groups.flatMap((group) =>
						chunk(group.items, BATCH_ITEMS).map((items) => ({
							workbase: group.workbase,
							items,
						})),
					)

					const results = new Map<string, TriageAssessment>()
					const failures: TriageFailure[] = []
					if (batches.length) {
						const settings = yield* carriedSettings(env)
						const outcomes = yield* Effect.forEach(
							batches,
							(batch) =>
								Effect.gen(function* () {
									return yield* runBatch(batch, {
										message: triageMessage(yield* sectionsFor(batch.workbase)),
										model,
										settings,
										env,
										snapshot: {
											contractVersion: TRIAGE_VERSION,
											generatedAt: report.generatedAt,
											workbase: workbaseRef(batch.workbase),
											items: batch.items.map((item) =>
												itemSnapshot(
													item,
													tails.get(item.key) ?? [],
													cache.get(item.key)?.assessment ?? null,
													{
														recentActions: actionsFor(item.key),
														snoozes: snoozesFor(item.key),
														dismissals: dismissalsFor(item.key),
													},
												),
											),
										},
									})
								}),
							{ concurrency: BATCH_CONCURRENCY },
						)
						for (const outcome of outcomes) {
							if (outcome.ok)
								for (const [key, assessment] of outcome.assessments)
									results.set(key, assessment)
							else failures.push(outcome.failure)
						}
					}

					const evaluatedAt = new Date().toISOString()
					const failedKeys = new Map(
						failures.flatMap((failure) =>
							failure.keys.map((key) => [key, failure.message] as const),
						),
					)
					/** Remove what the supervisor snoozed or dismissed. */
					const visible = (
						key: string,
						assessment: TriageAssessment | null,
					): {
						readonly assessment: TriageAssessment | null
						readonly suppressed: TriageReportItem["suppressed"]
					} => {
						const hidden = [...snoozesFor(key), ...dismissalsFor(key)]
						const suppressed = snoozesFor(key).some(
							(entry) => entry.actionId === null,
						)
							? "snoozed"
							: dismissalsFor(key).some((entry) => entry.actionId === null)
								? "dismissed"
								: null
						if (!assessment) return { assessment, suppressed }
						const actions = suppressed
							? []
							: assessment.actions.filter(
									(action) =>
										!hidden.some((entry) => entry.actionId === action.id),
								)
						const kept = new Set(actions.map((action) => action.id))
						return {
							assessment: {
								...assessment,
								actions,
								modelActionIds: assessment.modelActionIds.filter((id) =>
									kept.has(id),
								),
							},
							suppressed,
						}
					}
					const reportItems: TriageReportItem[] = items.map((item) => {
						const fingerprint = fingerprints.get(item.key)!
						const fresh = results.get(item.key)
						const previous = cache.get(item.key) ?? null
						const base = { key: item.key, subject: item.subject, fingerprint }
						if (fresh)
							return {
								...base,
								source: "fresh",
								evaluatedAt,
								...visible(item.key, fresh),
								error: null,
							}
						const error = failedKeys.get(item.key) ?? null
						if (error === null && previous)
							return {
								...base,
								source: "cached",
								evaluatedAt: previous.evaluatedAt,
								...visible(item.key, previous.assessment),
								error: null,
							}
						return {
							...base,
							source: previous ? "stale" : "failed",
							evaluatedAt: previous?.evaluatedAt ?? null,
							...visible(item.key, previous?.assessment ?? null),
							error,
						}
					})

					// Merge under the cache lock: replace only this run's results. A
					// full run also forgets items gone from the workbases it inspected.
					const inspected = new Set<string | null>(
						snapshot.workbases.map((workbase) => workbase.ref.root),
					)
					if (!options.workbase) inspected.add(null)
					const present = new Set(items.map((item) => item.key))
					const fresh: TriageCacheEntry[] = items.flatMap((item) => {
						const assessment = results.get(item.key)
						return assessment
							? [
									{
										key: item.key,
										workbase: item.workbase?.ref.root ?? null,
										fingerprint: fingerprints.get(item.key)!,
										evaluatedAt,
										assessment,
									},
								]
							: []
					})
					const freshKeys = new Set(fresh.map((entry) => entry.key))
					yield* state.updateTriageCache(
						(current) => [
							...current.filter(
								(entry) =>
									!freshKeys.has(entry.key) &&
									(!full ||
										present.has(entry.key) ||
										!inspected.has(entry.workbase)),
							),
							...fresh,
						],
						options.env,
					)
					// A full run over every workbase also drops dismissals for items
					// that are gone or whose dismissed state has changed.
					if (full && !options.workbase)
						yield* state.pruneDismissals(
							(entry) =>
								present.has(entry.key) &&
								(entry.fingerprint === null ||
									entry.fingerprint === fingerprints.get(entry.key)),
							options.env,
						)

					const count = (source: TriageReportItem["source"]) =>
						reportItems.filter((item) => item.source === source).length
					return {
						version: TRIAGE_VERSION,
						generatedAt: evaluatedAt,
						runtime: report.runtime,
						workbases: report.workbases.map((workbase) => ({
							id: workbase.id,
							name: workbase.name,
							root: workbase.root,
							available: workbase.available,
							error: workbase.error,
						})),
						items: reportItems,
						failures,
						summary: {
							total: reportItems.length,
							fresh: count("fresh"),
							cached: count("cached"),
							stale: count("stale"),
							failed: count("failed"),
						},
					} satisfies TriageReport
				})

			return { triage }
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
