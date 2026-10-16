import { Context, Data, Effect, Layer, Result } from "effect"
import { tmpdir } from "node:os"
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
	itemFingerprint,
	itemSnapshot,
	matchesItem,
	promptDigest,
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
import { TRIAGE_AGENT, triageAgentConfig } from "../workbase/triage-contract"
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
const RECENT_ACTIONS = 50

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

			const runOpenCode = (input: {
				readonly directory: string
				readonly message: string
				readonly files: readonly string[]
				readonly sessionId: string | null
				readonly model: string | undefined
				readonly env: NodeJS.ProcessEnv | undefined
			}) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const env = input.env ?? process.env
					const argv = [
						env.AGENCY_OPENCODE_BIN || "opencode",
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
							// OpenCode locates its project from $PWD, not the process cwd.
							env: {
								...Object.fromEntries(
									Object.entries(env).filter(
										(entry): entry is [string, string] =>
											entry[1] !== undefined,
									),
								),
								PWD: input.directory,
							},
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

			/** Run one workbase's changed items, retrying once on invalid replies. */
			const runBatch = (
				batch: Batch,
				input: {
					readonly directory: string
					readonly message: string
					readonly snapshot: unknown
					readonly model: string | undefined
					readonly env: NodeJS.ProcessEnv | undefined
				},
			) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const keys = batch.items.map((item) => item.key)
					// Inputs stay outside the agent's OpenCode project directory.
					const run = join(
						tmpdir(),
						`agency-triage-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
					)
					const files = {
						snapshot: join(run, "snapshot.json"),
						triage: join(run, "agency-triage-v1.schema.json"),
						action: join(run, "agency-action-v1.schema.json"),
					}
					yield* fs.createDirectory(run)
					yield* fs.writeJSON(files.snapshot, input.snapshot)
					yield* fs.writeJSON(files.triage, triageSchema)
					yield* fs.writeJSON(files.action, actionSchema)
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
								directory: input.directory,
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
							const validated = validateResponse(result.text, keys)
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
					return yield* attempt(input.message, null, 1).pipe(
						Effect.ensuring(fs.deleteDirectory(run).pipe(Effect.ignore)),
					)
				})

			const triage = (options: TriageOptions = {}) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const supervision = yield* SupervisionService
					const state = yield* SupervisionStateService
					const workbases = yield* WorkbaseService
					const env = options.env
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

					const global = yield* workbases.loadGlobalConfig(
						options.configDirectory,
					)
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

					const tails = yield* transcripts(items, env)
					const fingerprints = new Map<string, string>()
					for (const item of items) {
						fingerprints.set(
							item.key,
							itemFingerprint(
								item,
								tails.get(item.key) ?? [],
								promptDigest(yield* sectionsFor(item.workbase)),
							),
						)
					}
					const cache = new Map(
						(yield* state.triageCache(env)).map((entry) => [entry.key, entry]),
					)
					const changed = items.filter(
						(item) =>
							options.item !== undefined ||
							cache.get(item.key)?.fingerprint !== fingerprints.get(item.key),
					)
					const batches: Batch[] = []
					for (const item of changed) {
						const batch = batches.find(
							(entry) => entry.workbase === item.workbase,
						)
						if (batch) (batch.items as TriageItem[]).push(item)
						else batches.push({ workbase: item.workbase, items: [item] })
					}

					const directory = join(state.directory(env), "triage")
					const results = new Map<string, TriageAssessment>()
					const failures: TriageFailure[] = []
					if (batches.length) {
						const config = join(directory, ".opencode", "opencode.jsonc")
						const content = triageAgentConfig()
						const current = yield* fs
							.readFile(config)
							.pipe(Effect.orElseSucceed(() => null))
						if (current !== content) {
							yield* fs.createDirectory(dirname(config))
							yield* fs.writeFile(config, content)
						}
						const recentActions = yield* state.actions(
							{ limit: RECENT_ACTIONS },
							env,
						)
						const snoozes = yield* state.snoozes(env)
						const dismissals = yield* state.dismissals(env)
						const outcomes = yield* Effect.forEach(
							batches,
							(batch) =>
								Effect.gen(function* () {
									const keys = new Set(batch.items.map((item) => item.key))
									return yield* runBatch(batch, {
										directory,
										message: triageMessage(yield* sectionsFor(batch.workbase)),
										model: global.triage?.model,
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
												),
											),
											recentActions,
											snoozes: snoozes.filter((entry) => keys.has(entry.key)),
											dismissals: dismissals.filter((entry) =>
												keys.has(entry.key),
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
								assessment: fresh,
								error: null,
							}
						const error = failedKeys.get(item.key) ?? null
						if (error === null && previous)
							return {
								...base,
								source: "cached",
								evaluatedAt: previous.evaluatedAt,
								assessment: previous.assessment,
								error: null,
							}
						return {
							...base,
							source: previous ? "stale" : "failed",
							evaluatedAt: previous?.evaluatedAt ?? null,
							assessment: previous?.assessment ?? null,
							error,
						}
					})

					// A full run forgets items that are gone from the workbases it
					// inspected; a single-item run keeps everything else.
					const inspected = new Set<string | null>(
						snapshot.workbases.map((workbase) => workbase.ref.root),
					)
					if (!options.workbase) inspected.add(null)
					const present = new Set(items.map((item) => item.key))
					const entries: TriageCacheEntry[] = [...cache.values()].filter(
						(entry) =>
							options.item !== undefined ||
							present.has(entry.key) ||
							!inspected.has(entry.workbase),
					)
					for (const item of items) {
						const assessment = results.get(item.key)
						if (!assessment) continue
						const entry: TriageCacheEntry = {
							key: item.key,
							workbase: item.workbase?.ref.root ?? null,
							fingerprint: fingerprints.get(item.key)!,
							evaluatedAt,
							assessment,
						}
						const index = entries.findIndex((other) => other.key === item.key)
						if (index >= 0) entries[index] = entry
						else entries.push(entry)
					}
					yield* state.writeTriageCache(entries, env)

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
