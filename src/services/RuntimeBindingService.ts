import { Context, Effect, Layer, Option, Schema } from "effect"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { FileSystemService } from "./FileSystemService"
import { RuntimeService } from "./RuntimeService"
import type {
	GraphExecutionRuntime,
	GraphRuntime,
	GraphRuntimeBinding,
} from "../graph-schema"
import type { RuntimeKind, RuntimePane } from "../workbase/runtime"
import {
	executionUnitPaths,
	reconcileRuntime,
	RUNTIME_BINDING_VERSION,
	RuntimeBinding,
	type InferredBinding,
	type ReconciledBinding,
	type RuntimeUnit,
} from "../workbase/runtime-bindings"

export interface RuntimeInspection {
	readonly provider: RuntimeKind | null
	readonly available: boolean
	readonly error: string | null
	readonly bindings: readonly (
		| ReconciledBinding
		| {
				readonly binding: RuntimeBinding
				readonly state: "unknown"
				readonly panes: readonly RuntimePane[]
		  }
	)[]
	readonly inferred: readonly InferredBinding[]
	readonly unmanaged: readonly RuntimePane[]
}

export interface RuntimeUnitReference {
	readonly id: string
	readonly taskId: string
	readonly phaseId?: string
	readonly repo: string
}

export type InspectedBinding = RuntimeInspection["bindings"][number]

/**
 * Bindings are local operational state, never durable workbase content. They
 * live under $AGENCY_STATE_DIR (default: $XDG_STATE_HOME/agency or
 * ~/.local/state/agency), one file per workbase execution unit.
 */
const runtimeStateDirectory = (env: NodeJS.ProcessEnv = process.env) =>
	env.AGENCY_STATE_DIR ||
	join(env.XDG_STATE_HOME || join(env.HOME ?? ".", ".local", "state"), "agency")

const workbaseKey = (root: string) =>
	createHash("sha256").update(root).digest("hex").slice(0, 32)

const bindingsDirectory = (root: string, env: NodeJS.ProcessEnv) =>
	join(runtimeStateDirectory(env), "runtime-bindings", workbaseKey(root))

const bindingFile = (root: string, unit: string, env: NodeJS.ProcessEnv) =>
	join(bindingsDirectory(root, env), `${encodeURIComponent(unit)}.json`)

const decodeBinding = Schema.decodeUnknownOption(
	Schema.fromJsonString(RuntimeBinding),
)

export class RuntimeBindingService extends Context.Service<RuntimeBindingService>()(
	"RuntimeBindingService",
	{
		make: Effect.sync(() => {
			const canonicalRoot = (root: string) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					return yield* fs.realPath(root).pipe(Effect.orElseSucceed(() => root))
				})

			const list = (root: string, env: NodeJS.ProcessEnv = process.env) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const workbase = yield* canonicalRoot(root)
					const directory = bindingsDirectory(workbase, env)
					const entries = yield* fs
						.readDirectory(directory)
						.pipe(
							Effect.catchTag("FileNotFoundError", () => Effect.succeed([])),
						)
					const bindings: RuntimeBinding[] = []
					for (const entry of entries) {
						if (entry.isDirectory || !entry.name.endsWith(".json")) continue
						const content = yield* fs
							.readFile(join(directory, entry.name))
							.pipe(Effect.orElseSucceed(() => ""))
						const binding = decodeBinding(content)
						if (Option.isSome(binding) && binding.value.workbase === workbase) {
							bindings.push(binding.value)
						}
					}
					return bindings.sort((a, b) => a.unit.localeCompare(b.unit))
				})

			const record = (
				input: Omit<RuntimeBinding, "version" | "workbase" | "boundAt"> & {
					readonly root: string
					readonly boundAt?: string
				},
				env: NodeJS.ProcessEnv = process.env,
			) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const { root, ...fields } = input
					const workbase = yield* canonicalRoot(root)
					const binding: RuntimeBinding = {
						version: RUNTIME_BINDING_VERSION,
						workbase,
						...fields,
						boundAt: input.boundAt ?? new Date().toISOString(),
					}
					const path = bindingFile(workbase, binding.unit, env)
					const temporary = `${path}.${process.pid}.tmp`
					yield* fs.createDirectory(bindingsDirectory(workbase, env))
					yield* fs.writeJSON(temporary, binding)
					yield* fs.moveDirectory(temporary, path)
					return binding
				})

			return {
				list,
				record,

				/** Record the current runtime pane as hosting a just-claimed unit. */
				recordLaunch: (
					input: {
						readonly root: string
						readonly unit: string
						readonly agent: string | null
						readonly agentSessionId: string | null
						readonly agencySessionId: string | null
					},
					env: NodeJS.ProcessEnv = process.env,
				) =>
					Effect.gen(function* () {
						const runtime = yield* RuntimeService
						const provider = yield* runtime.provider(env)
						const location = provider?.currentLocation() ?? null
						if (!location) return null
						return yield* record(
							{
								root: input.root,
								unit: input.unit,
								runtime: location.runtime,
								paneId: location.paneId,
								tabId: location.tabId,
								workspaceId: location.workspaceId,
								agent: input.agent,
								agentSessionId: input.agentSessionId,
								agencySessionId: input.agencySessionId,
							},
							env,
						)
					}),

				/** Read-only reconciliation of stored bindings against the live runtime. */
				inspect: (
					root: string,
					units: readonly RuntimeUnitReference[],
					env: NodeJS.ProcessEnv = process.env,
				) =>
					Effect.gen(function* () {
						const runtime = yield* RuntimeService
						const bindings = yield* list(root, env)
						const roots = [...new Set([root, yield* canonicalRoot(root)])]
						const runtimeUnits: RuntimeUnit[] = units.map((unit) => {
							const paths = roots.map((base) =>
								executionUnitPaths(base, unit, unit.repo),
							)
							return {
								id: unit.id,
								directories: paths.map((path) => path.directory),
								checkoutPaths: paths.map((path) => path.checkoutPath),
							}
						})
						const provider = yield* runtime.provider(env)
						const unavailable = (error: string | null): RuntimeInspection => ({
							provider: provider?.kind ?? null,
							available: false,
							error,
							bindings: bindings.map((binding) => ({
								binding,
								state: "unknown" as const,
								panes: [],
							})),
							inferred: [],
							unmanaged: [],
						})
						if (!provider) return unavailable(null)
						return yield* provider.snapshot().pipe(
							Effect.map(
								(snapshot): RuntimeInspection => ({
									provider: provider.kind,
									available: true,
									error: null,
									...reconcileRuntime(bindings, snapshot, runtimeUnits),
								}),
							),
							Effect.catchTag("RuntimeError", (error) =>
								Effect.succeed(unavailable(error.message)),
							),
						)
					}),
			}
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}

const bindingView = (item: InspectedBinding): GraphRuntimeBinding => ({
	state: item.state,
	record: item.binding,
	panes: item.panes,
})

export const unitRuntimeView = (
	inspection: RuntimeInspection,
	unit: string,
): GraphExecutionRuntime => {
	const binding = inspection.bindings.find((item) => item.binding.unit === unit)
	return {
		binding: binding ? bindingView(binding) : null,
		inferred: inspection.inferred
			.filter((item) => item.unit === unit)
			.map(({ matchedBy, pane }) => ({ matchedBy, pane })),
	}
}

export const runtimeSummary = (
	inspection: RuntimeInspection,
	units: ReadonlySet<string>,
): GraphRuntime => ({
	provider: inspection.provider,
	available: inspection.available,
	error: inspection.error,
	unmanaged: inspection.unmanaged,
	orphaned: inspection.bindings
		.filter((item) => !units.has(item.binding.unit))
		.map(bindingView),
})
