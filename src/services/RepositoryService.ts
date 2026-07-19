import { Schema, TreeFormatter } from "@effect/schema"
import { Data, Effect, Either } from "effect"
import { join, resolve } from "node:path"
import { lstat, rename, rm } from "node:fs/promises"
import { FileSystemService } from "./FileSystemService"
import { GraphService } from "./GraphService"
import { WorkbaseService } from "./WorkbaseService"
import {
	directoryMoveStep,
	documentWriteStep,
	runLifecycleTransaction,
	type TransactionStep,
} from "./LifecycleTransaction"
import {
	RepositoryAlias,
	RepositoryRemote,
	WorkbaseConfig,
} from "../workbase/schemas"
import { documentRevision } from "../workbase/document-revision"

class RepositoryError extends Data.TaggedError("RepositoryError")<{
	readonly message: string
	readonly cause?: unknown
}> {}

type RepositoryState =
	| "declared"
	| "materialized"
	| "linked"
	| "missing"
	| "invalid"
	| "remote-drifted"

interface RepositoryInfo {
	readonly alias: string
	readonly path: string
	readonly kind: "bare" | "repository" | "symlink" | null
	readonly remote: string | null
	readonly declaredRemote: string | null
	readonly target: string | null
	readonly states: readonly RepositoryState[]
}

interface RepositoryVerification extends RepositoryInfo {
	readonly valid: boolean
	readonly issues: readonly string[]
}

interface RepositorySetupAction {
	readonly kind: "materialize" | "adopt"
	readonly alias: string
	readonly remote: string
	readonly status: "planned" | "applied"
}

interface RepositorySetupIssue {
	readonly alias: string
	readonly state: "invalid" | "remote-drifted" | "undeclared"
	readonly message: string
	readonly action: string
}

export interface RepositorySetupResult {
	readonly root: string
	readonly mode: "dry-run" | "apply"
	readonly actions: readonly RepositorySetupAction[]
	readonly unresolved: readonly RepositorySetupIssue[]
	readonly repositories: readonly RepositoryInfo[]
}

const validate = <S extends Schema.Schema.AnyNoContext>(
	schema: S,
	value: unknown,
	label: string,
) => {
	const result = Schema.decodeUnknownEither(schema)(value)
	return Either.isLeft(result)
		? Effect.fail(
				new RepositoryError({
					message: `Invalid ${label} '${String(value)}': ${TreeFormatter.formatErrorSync(result.left)}`,
				}),
			)
		: Effect.succeed(result.right)
}

const validateAlias = (alias: string) =>
	validate(RepositoryAlias, alias, "repository alias")

const validateRemote = (remote: string) => {
	if (!remote.trim()) {
		return Effect.fail(
			new RepositoryError({ message: "Repository remote is required" }),
		)
	}
	return validate(RepositoryRemote, remote, "portable repository remote")
}

const sortedDeclarations = (
	repositories: WorkbaseConfig["repositories"] | undefined,
) =>
	Object.fromEntries(
		Object.entries(repositories ?? {}).sort(([left], [right]) =>
			left.localeCompare(right),
		),
	)

const configContent = (config: WorkbaseConfig) =>
	JSON.stringify(
		{
			...config,
			...(config.repositories
				? { repositories: sortedDeclarations(config.repositories) }
				: {}),
		},
		null,
		2,
	) + "\n"

const configState = (startPath: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystemService
		const workbase = yield* WorkbaseService
		const root = yield* workbase.discover(startPath)
		const path = join(root, "agency.json")
		const content = yield* fs.readFile(path)
		let input: unknown
		try {
			input = JSON.parse(content)
		} catch (cause) {
			return yield* new RepositoryError({
				message: `Invalid JSON in ${path}`,
				cause,
			})
		}
		const decoded = Schema.decodeUnknownEither(WorkbaseConfig, {
			errors: "all",
			onExcessProperty: "error",
		})(input)
		if (Either.isLeft(decoded)) {
			return yield* new RepositoryError({
				message: `Invalid workbase configuration in ${path}:\n${TreeFormatter.formatErrorSync(decoded.left)}`,
			})
		}
		return {
			root,
			config: decoded.right,
			path,
			revision: documentRevision(content),
		}
	})

const withDeclarations = (
	config: WorkbaseConfig,
	repositories: NonNullable<WorkbaseConfig["repositories"]>,
): WorkbaseConfig => ({
	...config,
	repositories: sortedDeclarations(repositories),
})

const inspectRemote = (path: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystemService
		const result = yield* fs.runCommand(
			["git", "-C", path, "remote", "get-url", "origin"],
			{ captureOutput: true },
		)
		return result.exitCode === 0 ? result.stdout.trim() : null
	})

const portableRemote = (path: string) =>
	Effect.gen(function* () {
		const remote = yield* inspectRemote(path)
		if (!remote) {
			return yield* new RepositoryError({
				message: `Repository '${path}' has no portable origin remote`,
			})
		}
		return yield* validateRemote(remote)
	})

const find = (alias: string, startPath: string) =>
	Effect.gen(function* () {
		const service = yield* RepositoryService
		const validAlias = yield* validateAlias(alias)
		const repositories = yield* service.list(startPath)
		const repository = repositories.find((item) => item.alias === validAlias)
		if (!repository) {
			return yield* new RepositoryError({
				message: `Unknown repository alias '${validAlias}'`,
			})
		}
		return repository
	})

const requireMaterialized = (repository: RepositoryInfo) =>
	repository.states.includes("missing")
		? Effect.fail(
				new RepositoryError({
					message: `Repository alias '${repository.alias}' is declared but missing; run 'agency repo setup --apply'`,
				}),
			)
		: repository.states.includes("invalid")
			? Effect.fail(
					new RepositoryError({
						message: `Repository alias '${repository.alias}' has an invalid local path`,
					}),
				)
			: Effect.succeed(repository)

const removalBlockers = (repository: RepositoryInfo, startPath: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystemService
		const graph = yield* GraphService
		const report = yield* graph.get({ cwd: startPath })
		const repositoryId = `repository:${repository.alias}`
		const references = report.edges
			.filter(
				(edge) =>
					edge.to === repositoryId &&
					(edge.kind === "writes" || edge.kind === "references"),
			)
			.map((edge) => edge.from)
			.sort()
		const worktrees: string[] = []
		if (repository.kind !== null && !repository.states.includes("invalid")) {
			const linkedTarget =
				repository.kind === "symlink"
					? yield* fs.realPath(repository.path)
					: null
			const result = yield* fs.runCommand(
				["git", "-C", repository.path, "worktree", "list", "--porcelain"],
				{ captureOutput: true },
			)
			if (result.exitCode === 0) {
				for (const block of result.stdout.trim().split(/\n\n+/)) {
					if (!block || /(^|\n)bare(\n|$)/.test(block)) continue
					const path = block.match(/^worktree (.+)$/m)?.[1]
					if (path && path !== linkedTarget) worktrees.push(path)
				}
			}
		}
		return { references, worktrees }
	})

const assertRemovable = (repository: RepositoryInfo, startPath: string) =>
	Effect.gen(function* () {
		const blockers = yield* removalBlockers(repository, startPath)
		const details = [
			...blockers.references.map((item) => `active reference ${item}`),
			...blockers.worktrees.map((item) => `linked worktree ${item}`),
		]
		if (details.length > 0) {
			return yield* new RepositoryError({
				message: `Repository alias '${repository.alias}' is in use and cannot be removed or renamed:\n${details.map((item) => `- ${item}`).join("\n")}`,
			})
		}
	})

const effectPreflightStep = (
	label: string,
	check: Effect.Effect<void, unknown, never>,
): TransactionStep => ({
	label,
	preflight: () => Effect.runPromise(check),
	apply: async () => undefined,
})

const deleteAfterMoveStep = (
	root: string,
	from: string,
	to: string,
): TransactionStep => ({
	...directoryMoveStep(root, from, to),
	finalize: () => rm(to, { recursive: true, force: true }),
	manualRecovery: `Remove ${to} or move it back to ${from}`,
})

const replaceWithMoveStep = (
	current: string,
	replacement: string,
	backup: string,
): TransactionStep => ({
	label: `replace ${current} with ${replacement}`,
	preflight: async () => {
		await lstat(current)
		await lstat(replacement)
		try {
			await lstat(backup)
			throw new Error(`Replacement backup already exists: ${backup}`)
		} catch (cause) {
			if (
				typeof cause !== "object" ||
				cause === null ||
				!("code" in cause) ||
				cause.code !== "ENOENT"
			)
				throw cause
		}
	},
	apply: async () => {
		await rename(current, backup)
		try {
			await rename(replacement, current)
		} catch (cause) {
			await rename(backup, current)
			throw cause
		}
	},
	rollback: async () => {
		await rename(current, replacement)
		await rename(backup, current)
	},
	finalize: () => rm(backup, { recursive: true, force: true }),
	manualRecovery: `Restore ${backup} to ${current}`,
})

const runTransaction = (
	state: Effect.Effect.Success<ReturnType<typeof configState>>,
	config: WorkbaseConfig,
	steps: readonly TransactionStep[],
) =>
	runLifecycleTransaction({
		root: state.root,
		preconditions: [{ path: state.path, revision: state.revision }],
		steps: [
			...steps,
			documentWriteStep(state.root, [
				{ path: state.path, content: configContent(config) },
			]),
		],
	}).pipe(
		Effect.mapError(
			(cause) => new RepositoryError({ message: cause.message, cause }),
		),
	)

export class RepositoryService extends Effect.Service<RepositoryService>()(
	"RepositoryService",
	{
		sync: () => ({
			add: (alias: string, remote: string, startPath: string = process.cwd()) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const validAlias = yield* validateAlias(alias)
					const state = yield* configState(startPath)
					const destination = join(state.root, "repos", validAlias)
					if (
						state.config.repositories?.[validAlias] ||
						(yield* fs.exists(destination))
					) {
						return yield* new RepositoryError({
							message: `Repository alias '${validAlias}' already exists`,
						})
					}

					const inputIsPortable = Either.isRight(
						Schema.decodeUnknownEither(RepositoryRemote)(remote),
					)
					const cloneSource = inputIsPortable
						? remote
						: resolve(startPath, remote)
					const declaredRemote = inputIsPortable
						? yield* validateRemote(remote)
						: yield* portableRemote(cloneSource)
					const staging = join(
						state.root,
						"repos",
						`.agency-clone-${validAlias}-${process.pid}-${Date.now()}`,
					)
					yield* fs.createDirectory(join(state.root, "repos"))
					const cloned = yield* fs.runCommand(
						["git", "clone", "--bare", "--", cloneSource, staging],
						{ captureOutput: true },
					)
					if (cloned.exitCode !== 0) {
						yield* fs.deleteDirectory(staging).pipe(Effect.ignore)
						return yield* new RepositoryError({
							message: `Failed to clone repository '${remote}': ${cloned.stderr.trim()}`,
						})
					}
					if (declaredRemote !== remote) {
						const setRemote = yield* fs.runCommand(
							[
								"git",
								"-C",
								staging,
								"remote",
								"set-url",
								"origin",
								declaredRemote,
							],
							{ captureOutput: true },
						)
						if (setRemote.exitCode !== 0) {
							yield* fs.deleteDirectory(staging).pipe(Effect.ignore)
							return yield* new RepositoryError({
								message: `Failed to record portable remote for repository '${validAlias}': ${setRemote.stderr.trim()}`,
							})
						}
					}
					const config = withDeclarations(state.config, {
						...(state.config.repositories ?? {}),
						[validAlias]: { remote: declaredRemote },
					})
					yield* runTransaction(state, config, [
						directoryMoveStep(state.root, staging, destination),
					]).pipe(
						Effect.ensuring(fs.deleteDirectory(staging).pipe(Effect.ignore)),
					)
					return destination
				}),

			link: (
				alias: string,
				target: string,
				startPath: string = process.cwd(),
			) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const graph = yield* GraphService
					const workbase = yield* WorkbaseService
					const validAlias = yield* validateAlias(alias)
					const state = yield* configState(startPath)
					const destination = join(state.root, "repos", validAlias)
					const resolvedTarget = resolve(startPath, target)
					const existing = (yield* RepositoryService)
						.list(state.root)
						.pipe(
							Effect.map((items) =>
								items.find((item) => item.alias === validAlias),
							),
						)
					const current = yield* existing
					const localCurrent =
						current && !current.states.includes("missing") ? current : undefined
					if (localCurrent?.kind === "symlink") {
						return yield* new RepositoryError({
							message: `Repository alias '${validAlias}' is already linked`,
						})
					}
					if (!(yield* fs.isDirectory(resolvedTarget))) {
						return yield* new RepositoryError({
							message: `Repository path does not exist: ${resolvedTarget}`,
						})
					}
					const git = yield* fs.runCommand(
						["git", "-C", resolvedTarget, "rev-parse", "--git-dir"],
						{ captureOutput: true },
					)
					if (git.exitCode !== 0) {
						return yield* new RepositoryError({
							message: `Path is not a Git repository: ${resolvedTarget}`,
						})
					}
					const declaredRemote =
						state.config.repositories?.[validAlias]?.remote ??
						(yield* portableRemote(resolvedTarget))
					const staging = join(
						state.root,
						"repos",
						`.agency-link-${validAlias}-${process.pid}-${Date.now()}`,
					)
					yield* fs.createDirectory(join(state.root, "repos"))
					yield* fs.createSymlink(resolvedTarget, staging)
					const config = withDeclarations(state.config, {
						...(state.config.repositories ?? {}),
						[validAlias]: { remote: declaredRemote },
					})
					const replaced = join(
						state.root,
						"repos",
						`.agency-replaced-${validAlias}-${process.pid}-${Date.now()}`,
					)
					const safety = localCurrent
						? effectPreflightStep(
								`verify repository safety for ${validAlias}`,
								assertRemovable(localCurrent, state.root).pipe(
									Effect.provideService(FileSystemService, fs),
									Effect.provideService(GraphService, graph),
									Effect.provideService(WorkbaseService, workbase),
								),
							)
						: null
					yield* runTransaction(
						state,
						config,
						localCurrent
							? [safety!, replaceWithMoveStep(destination, staging, replaced)]
							: [directoryMoveStep(state.root, staging, destination)],
					).pipe(
						Effect.ensuring(fs.deleteDirectory(staging).pipe(Effect.ignore)),
					)
					return destination
				}),

			list: (startPath: string = process.cwd()) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const { root, config } = yield* WorkbaseService.pipe(
						Effect.flatMap((service) => service.loadConfig(startPath)),
					)
					const reposPath = join(root, "repos")
					const entries = (yield* fs.isDirectory(reposPath))
						? (yield* fs.readDirectory(reposPath)).filter(
								(entry) => !entry.name.startsWith(".agency-"),
							)
						: []
					const local = new Map(entries.map((entry) => [entry.name, entry]))
					const aliases = new Set([
						...Object.keys(config.repositories ?? {}),
						...local.keys(),
					])
					const repositories: RepositoryInfo[] = []

					for (const alias of [...aliases].sort()) {
						const path = join(reposPath, alias)
						const entry = local.get(alias)
						const declaredRemote = config.repositories?.[alias]?.remote ?? null
						if (!entry) {
							repositories.push({
								alias,
								path,
								kind: null,
								remote: null,
								declaredRemote,
								target: null,
								states: ["declared", "missing"],
							})
							continue
						}
						if (!entry.isDirectory && !entry.isSymlink) {
							repositories.push({
								alias,
								path,
								kind: null,
								remote: null,
								declaredRemote,
								target: null,
								states: [
									...(declaredRemote ? (["declared"] as const) : []),
									"invalid",
								],
							})
							continue
						}
						const target = entry.isSymlink
							? yield* fs.readSymlinkTarget(path)
							: null
						const git = yield* fs.runCommand(
							["git", "-C", path, "rev-parse", "--git-dir"],
							{ captureOutput: true },
						)
						const bare = yield* fs.runCommand(
							["git", "-C", path, "rev-parse", "--is-bare-repository"],
							{ captureOutput: true },
						)
						const remote =
							git.exitCode === 0 ? yield* inspectRemote(path) : null
						const states: RepositoryState[] = []
						if (declaredRemote) states.push("declared")
						states.push(entry.isSymlink ? "linked" : "materialized")
						if (git.exitCode !== 0) states.push("invalid")
						if (declaredRemote && remote !== declaredRemote)
							states.push("remote-drifted")
						repositories.push({
							alias,
							path,
							kind: entry.isSymlink
								? "symlink"
								: bare.stdout.trim() === "true"
									? "bare"
									: "repository",
							remote,
							declaredRemote,
							target,
							states,
						})
					}
					return repositories
				}),

			show: (alias: string, startPath: string = process.cwd()) =>
				find(alias, startPath),

			fetch: (alias: string, startPath: string = process.cwd()) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const repository = yield* find(alias, startPath).pipe(
						Effect.flatMap(requireMaterialized),
					)
					const result = yield* fs.runCommand(
						["git", "-C", repository.path, "fetch", "--prune"],
						{ captureOutput: true },
					)
					if (result.exitCode !== 0) {
						return yield* new RepositoryError({
							message: `Failed to fetch repository '${alias}': ${result.stderr.trim()}`,
						})
					}
					return repository
				}),

			remove: (alias: string, startPath: string = process.cwd()) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const graph = yield* GraphService
					const workbase = yield* WorkbaseService
					const repository = yield* find(alias, startPath)
					const state = yield* configState(startPath)
					const declarations = { ...(state.config.repositories ?? {}) }
					delete declarations[repository.alias]
					const config = withDeclarations(state.config, declarations)
					const exists = yield* fs.exists(repository.path)
					const staging = join(
						state.root,
						"repos",
						`.agency-remove-${repository.alias}-${process.pid}-${Date.now()}`,
					)
					const safety = effectPreflightStep(
						`verify repository safety for ${repository.alias}`,
						assertRemovable(repository, startPath).pipe(
							Effect.provideService(FileSystemService, fs),
							Effect.provideService(GraphService, graph),
							Effect.provideService(WorkbaseService, workbase),
						),
					)
					yield* runTransaction(
						state,
						config,
						exists
							? [
									safety,
									deleteAfterMoveStep(state.root, repository.path, staging),
								]
							: [safety],
					)
					return repository
				}),

			unlink: (alias: string, startPath: string = process.cwd()) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const graph = yield* GraphService
					const workbase = yield* WorkbaseService
					const repository = yield* find(alias, startPath)
					if (repository.kind !== "symlink") {
						return yield* new RepositoryError({
							message: `Repository alias '${alias}' is not a link; use 'agency repo remove ${alias}'`,
						})
					}
					const state = yield* configState(startPath)
					const staging = join(
						state.root,
						"repos",
						`.agency-unlink-${repository.alias}-${process.pid}-${Date.now()}`,
					)
					yield* runLifecycleTransaction({
						root: state.root,
						preconditions: [{ path: state.path, revision: state.revision }],
						steps: [
							effectPreflightStep(
								`verify repository safety for ${repository.alias}`,
								assertRemovable(repository, startPath).pipe(
									Effect.provideService(FileSystemService, fs),
									Effect.provideService(GraphService, graph),
									Effect.provideService(WorkbaseService, workbase),
								),
							),
							deleteAfterMoveStep(state.root, repository.path, staging),
						],
					}).pipe(
						Effect.mapError(
							(cause) => new RepositoryError({ message: cause.message, cause }),
						),
					)
					return repository
				}),

			rename: (
				alias: string,
				newAlias: string,
				startPath: string = process.cwd(),
			) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const graph = yield* GraphService
					const workbase = yield* WorkbaseService
					const repository = yield* find(alias, startPath)
					const validNewAlias = yield* validateAlias(newAlias)
					const state = yield* configState(startPath)
					const destination = join(state.root, "repos", validNewAlias)
					if (
						state.config.repositories?.[validNewAlias] ||
						(yield* fs.exists(destination))
					) {
						return yield* new RepositoryError({
							message: `Repository alias '${validNewAlias}' already exists`,
						})
					}
					const remote =
						state.config.repositories?.[repository.alias]?.remote ??
						repository.remote
					if (!remote) {
						return yield* new RepositoryError({
							message: `Repository alias '${alias}' has no portable remote and cannot be renamed before adoption`,
						})
					}
					const portable = yield* validateRemote(remote)
					const declarations = { ...(state.config.repositories ?? {}) }
					delete declarations[repository.alias]
					declarations[validNewAlias] = { remote: portable }
					const exists = yield* fs.exists(repository.path)
					const safety = effectPreflightStep(
						`verify repository safety for ${repository.alias}`,
						assertRemovable(repository, startPath).pipe(
							Effect.provideService(FileSystemService, fs),
							Effect.provideService(GraphService, graph),
							Effect.provideService(WorkbaseService, workbase),
						),
					)
					yield* runTransaction(
						state,
						withDeclarations(state.config, declarations),
						exists
							? [
									safety,
									directoryMoveStep(state.root, repository.path, destination),
								]
							: [safety],
					)
					return yield* find(validNewAlias, startPath)
				}),

			remote: (
				alias: string,
				remote: string | undefined,
				startPath: string = process.cwd(),
			) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const repository = yield* find(alias, startPath)
					if (remote === undefined) return repository
					const portable = yield* validateRemote(remote)
					const state = yield* configState(startPath)
					const config = withDeclarations(state.config, {
						...(state.config.repositories ?? {}),
						[repository.alias]: { remote: portable },
					})
					const steps: TransactionStep[] = []
					if (
						repository.kind !== null &&
						repository.kind !== "symlink" &&
						!repository.states.includes("invalid")
					) {
						const previous = repository.remote
						const update = (value: string | null) =>
							Effect.runPromise(
								fs.runCommand(
									value === null
										? [
												"git",
												"-C",
												repository.path,
												"remote",
												"remove",
												"origin",
											]
										: [
												"git",
												"-C",
												repository.path,
												"remote",
												previous === null ? "add" : "set-url",
												"origin",
												value,
											],
									{ captureOutput: true },
								),
							).then((result) => {
								if (result.exitCode !== 0) throw new Error(result.stderr.trim())
							})
						steps.push({
							label: `update origin for repos/${repository.alias}`,
							preflight: async () => {
								const stats = await lstat(repository.path)
								if (stats.isSymbolicLink()) {
									throw new Error(
										`Repository alias '${repository.alias}' changed to a linked checkout; retry the remote update`,
									)
								}
								const current = await Effect.runPromise(
									fs.runCommand(
										[
											"git",
											"-C",
											repository.path,
											"remote",
											"get-url",
											"origin",
										],
										{ captureOutput: true },
									),
								)
								const currentRemote =
									current.exitCode === 0 ? current.stdout.trim() : null
								if (currentRemote !== previous) {
									throw new Error(
										`Origin for repository '${repository.alias}' changed; retry the remote update`,
									)
								}
							},
							apply: () => update(portable),
							rollback: () => update(previous),
							manualRecovery: `Restore origin for ${repository.path} to ${previous ?? "no remote"}`,
						})
					}
					yield* runTransaction(state, config, steps)
					return yield* find(alias, startPath)
				}),

			verify: (alias: string, startPath: string = process.cwd()) =>
				Effect.gen(function* () {
					const repository = yield* find(alias, startPath)
					const issues: string[] = []
					if (repository.states.includes("missing"))
						issues.push("Local materialization is missing")
					if (repository.states.includes("invalid"))
						issues.push("Path is not a Git repository")
					if (!repository.declaredRemote)
						issues.push("Portable remote is not declared")
					if (repository.states.includes("remote-drifted"))
						issues.push("Origin remote differs from the portable declaration")
					return {
						...repository,
						valid: issues.length === 0,
						issues,
					} satisfies RepositoryVerification
				}),

			setup: (
				options: { readonly cwd?: string; readonly apply?: boolean } = {},
			) =>
				Effect.gen(function* () {
					const service = yield* RepositoryService
					const fs = yield* FileSystemService
					const state = yield* configState(options.cwd ?? process.cwd())
					const repositories = yield* service.list(state.root)
					const planned: Omit<RepositorySetupAction, "status">[] = []
					const unresolved: RepositorySetupIssue[] = []

					for (const repository of repositories) {
						if (repository.states.includes("invalid")) {
							unresolved.push({
								alias: repository.alias,
								state: "invalid",
								message: `Local path for '${repository.alias}' is not a valid Git repository`,
								action: `Repair the path or run 'agency repo remove ${repository.alias}' before setup`,
							})
							continue
						}
						if (repository.states.includes("remote-drifted")) {
							unresolved.push({
								alias: repository.alias,
								state: "remote-drifted",
								message: `Origin for '${repository.alias}' differs from its portable declaration`,
								action: `Choose the intended remote explicitly with 'agency repo remote ${repository.alias} <remote>'`,
							})
							continue
						}
						if (
							repository.states.includes("missing") &&
							repository.declaredRemote
						) {
							planned.push({
								kind: "materialize",
								alias: repository.alias,
								remote: repository.declaredRemote,
							})
							continue
						}
						if (!repository.states.includes("declared")) {
							const decoded = repository.remote
								? Schema.decodeUnknownEither(RepositoryRemote)(
										repository.remote,
									)
								: null
							if (decoded && Either.isRight(decoded)) {
								planned.push({
									kind: "adopt",
									alias: repository.alias,
									remote: decoded.right,
								})
							} else {
								unresolved.push({
									alias: repository.alias,
									state: "undeclared",
									message: `Local repository '${repository.alias}' has no portable remote declaration`,
									action: `Set a portable origin, then rerun 'agency repo setup --apply'`,
								})
							}
						}
					}

					if (options.apply === true && planned.length > 0) {
						const staging: { alias: string; from: string; to: string }[] = []
						for (const action of planned.filter(
							(action) => action.kind === "materialize",
						)) {
							const from = join(
								state.root,
								"repos",
								`.agency-setup-${action.alias}-${process.pid}-${Date.now()}`,
							)
							yield* fs.createDirectory(join(state.root, "repos"))
							const cloned = yield* fs.runCommand(
								["git", "clone", "--bare", "--", action.remote, from],
								{ captureOutput: true },
							)
							if (cloned.exitCode !== 0) {
								for (const item of staging)
									yield* fs.deleteDirectory(item.from).pipe(Effect.ignore)
								return yield* new RepositoryError({
									message: `Failed to materialize repository '${action.alias}': ${cloned.stderr.trim()}`,
								})
							}
							staging.push({
								alias: action.alias,
								from,
								to: join(state.root, "repos", action.alias),
							})
						}
						const declarations = { ...(state.config.repositories ?? {}) }
						for (const action of planned) {
							declarations[action.alias] = { remote: action.remote }
						}
						yield* runTransaction(
							state,
							withDeclarations(state.config, declarations),
							staging.map((item) =>
								directoryMoveStep(state.root, item.from, item.to),
							),
						).pipe(
							Effect.ensuring(
								Effect.forEach(staging, (item) =>
									fs.deleteDirectory(item.from).pipe(Effect.ignore),
								).pipe(Effect.asVoid),
							),
						)
					}

					return {
						root: state.root,
						mode: options.apply === true ? "apply" : "dry-run",
						actions: planned.map((action) => ({
							...action,
							status: options.apply === true ? "applied" : "planned",
						})),
						unresolved,
						repositories:
							options.apply === true
								? yield* service.list(state.root)
								: repositories,
					} satisfies RepositorySetupResult
				}),
		}),
	},
) {}
