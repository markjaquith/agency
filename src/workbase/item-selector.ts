import { Data, Effect } from "effect"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { FileSystemService } from "../services/FileSystemService"
import { WorkbaseService } from "../services/WorkbaseService"

export type ItemLocation =
	| {
			readonly kind: "epic"
			readonly archived: boolean
			readonly epicId: string
	  }
	| {
			readonly kind: "task"
			readonly archived: boolean
			readonly taskId: string
	  }
	| {
			readonly kind: "phase"
			readonly archived: boolean
			readonly taskId: string
			readonly phaseId: string
	  }

class ItemSelectorError extends Data.TaggedError("ItemSelectorError")<{
	readonly selector?: string
	readonly message: string
}> {}

/**
 * Identify the epic, task, or phase containing `path` from its position in the
 * workbase. Document files, item directories, and anything nested inside them
 * (including generated checkouts under `code/`) resolve to their item.
 */
export const locateItem = (root: string, path: string): ItemLocation | null => {
	const child = relative(root, path)
	if (
		!child ||
		isAbsolute(child) ||
		child === ".." ||
		child.startsWith(`..${sep}`)
	)
		return null
	const parts = child.split(sep)
	const archived = parts[0] === "archive"
	const [collection, id, nested, phaseId] = archived ? parts.slice(1) : parts
	if (!id) return null
	if (collection === "epics") return { kind: "epic", archived, epicId: id }
	if (collection !== "tasks") return null
	if (nested === "phases" && phaseId)
		return { kind: "phase", archived, taskId: id, phaseId }
	return { kind: "task", archived, taskId: id }
}

const isBareSelector = (selector: string) =>
	selector !== "." &&
	selector !== ".." &&
	!selector.includes("/") &&
	!selector.includes(sep)

const documentPath = (
	root: string,
	archived: boolean,
	kind: "epic" | "task",
	id: string,
) =>
	join(
		root,
		...(archived ? ["archive"] : []),
		kind === "epic" ? "epics" : "tasks",
		id,
		kind === "epic" ? "EPIC.md" : "TASK.md",
	)

interface ResolveOptions {
	/** Resolve archived items instead of active ones, or accept either. */
	readonly archived?: boolean | "any"
}

const archiveMatches = (
	location: ItemLocation,
	archived: ResolveOptions["archived"],
) => archived === "any" || location.archived === (archived === true)

const describeTarget = (selector: string | undefined, candidate: string) =>
	selector === undefined ? `current directory ${candidate}` : candidate

/**
 * Shared positional selector resolution. A bare selector names an item ID when
 * that item exists or no matching path exists; otherwise the selector is a
 * path, and an omitted selector means the current directory.
 */
const locate = (
	kind: "epic" | "task",
	selector: string | undefined,
	cwd: string,
	options: ResolveOptions,
) =>
	Effect.gen(function* () {
		const fs = yield* FileSystemService
		const workbase = yield* WorkbaseService
		const base = resolve(cwd)
		const candidate = resolve(base, selector ?? ".")
		const candidateExists = yield* fs.exists(candidate)
		const root = yield* workbase.discover(candidateExists ? candidate : base)
		const bare = selector !== undefined && isBareSelector(selector)
		const documentExists = (archived: boolean) =>
			fs.exists(documentPath(root, archived, kind, selector!))
		if (
			bare &&
			(!candidateExists ||
				(options.archived !== true && (yield* documentExists(false))) ||
				(options.archived && (yield* documentExists(true))))
		) {
			return { root, id: selector, location: null }
		}
		if (!candidateExists) {
			return yield* new ItemSelectorError({
				selector,
				message: `Path does not exist: ${candidate}`,
			})
		}
		const location = locateItem(
			yield* fs.realPath(root),
			yield* fs.realPath(candidate),
		)
		return { root, id: undefined, location, candidate }
	})

const mismatch = (
	kind: string,
	selector: string | undefined,
	candidate: string,
	location: ItemLocation | null,
	archived: ResolveOptions["archived"],
) => {
	const state =
		archived === "any" ? "a" : archived ? "an archived" : "an active"
	return new ItemSelectorError({
		selector,
		message:
			location && !archiveMatches(location, archived)
				? `${describeTarget(selector, candidate)} identifies ${location.archived ? "an archived" : "an active"} ${location.kind}, not ${state} ${kind}`
				: `${describeTarget(selector, candidate)} does not identify ${state} ${kind}`,
	})
}

export const resolveEpicSelector = (
	selector: string | undefined,
	cwd: string,
	options: ResolveOptions = {},
) =>
	Effect.gen(function* () {
		const result = yield* locate("epic", selector, cwd, options)
		if (result.id !== undefined) return { root: result.root, epicId: result.id }
		const { location } = result
		if (location?.kind === "epic" && archiveMatches(location, options.archived))
			return { root: result.root, epicId: location.epicId }
		if (selector !== undefined && isBareSelector(selector))
			return { root: result.root, epicId: selector }
		return yield* mismatch(
			"epic",
			selector,
			result.candidate!,
			location,
			options.archived,
		)
	})

/**
 * Resolve a task selector. A path inside a phase resolves to its task and also
 * reports the phase, which commands with an optional phase slot may adopt.
 */
export const resolveTaskSelector = (
	selector: string | undefined,
	cwd: string,
	options: ResolveOptions = {},
) =>
	Effect.gen(function* () {
		const result = yield* locate("task", selector, cwd, options)
		if (result.id !== undefined)
			return {
				root: result.root,
				taskId: result.id,
				phaseId: undefined as string | undefined,
			}
		const { location } = result
		if (
			(location?.kind === "task" || location?.kind === "phase") &&
			archiveMatches(location, options.archived)
		) {
			return {
				root: result.root,
				taskId: location.taskId,
				phaseId: location.kind === "phase" ? location.phaseId : undefined,
			}
		}
		if (selector !== undefined && isBareSelector(selector))
			return {
				root: result.root,
				taskId: selector,
				phaseId: undefined as string | undefined,
			}
		return yield* mismatch(
			"task",
			selector,
			result.candidate!,
			location,
			options.archived,
		)
	})

/**
 * Resolve the `[<phase-path> | <task> <phase-id>]` selector shape. A single
 * bare selector names a phase of the task containing `cwd`.
 */
export const resolvePhaseSelector = (
	selector: string | undefined,
	phaseId: string | undefined,
	cwd: string,
	options: ResolveOptions = {},
) =>
	Effect.gen(function* () {
		const parent = { archived: options.archived && ("any" as const) }
		if (phaseId !== undefined) {
			const task = yield* resolveTaskSelector(selector, cwd, parent)
			return { root: task.root, taskId: task.taskId, phaseId }
		}
		if (selector !== undefined && isBareSelector(selector)) {
			const current = yield* resolveTaskSelector(undefined, cwd, parent).pipe(
				Effect.option,
			)
			if (current._tag === "Some")
				return {
					root: current.value.root,
					taskId: current.value.taskId,
					phaseId: selector,
				}
		}
		const result = yield* locate("task", selector, cwd, options)
		if (result.id !== undefined) {
			return yield* new ItemSelectorError({
				selector,
				message: `Phase selector '${selector}' requires a task; provide <task> <phase-id> or run inside a task`,
			})
		}
		const { location } = result
		if (
			location?.kind === "phase" &&
			archiveMatches(location, options.archived)
		)
			return {
				root: result.root,
				taskId: location.taskId,
				phaseId: location.phaseId,
			}
		return yield* mismatch(
			"phase",
			selector,
			result.candidate!,
			location,
			options.archived,
		)
	})

/**
 * Resolve a dependency reference: bare values remain IDs while paths resolve to
 * the task or phase they identify.
 */
export const resolveDependencySelector = (
	kind: "task" | "phase",
	selector: string,
	cwd: string,
) =>
	isBareSelector(selector)
		? Effect.succeed(selector)
		: kind === "task"
			? resolveTaskSelector(selector, cwd).pipe(
					Effect.map(({ taskId }) => taskId),
				)
			: resolvePhaseSelector(selector, undefined, cwd).pipe(
					Effect.map(({ phaseId }) => phaseId),
				)

/**
 * Split positional arguments into leading selector slots and a fixed number of
 * trailing operands, so selectors may be omitted.
 */
export const splitSelectorArgs = (
	args: readonly string[],
	trailing: number,
): {
	readonly selectors: readonly string[]
	readonly operands: readonly string[]
} => {
	const count = Math.max(0, args.length - trailing)
	return { selectors: args.slice(0, count), operands: args.slice(count) }
}
