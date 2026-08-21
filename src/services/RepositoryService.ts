import { Schema, TreeFormatter } from "@effect/schema"
import { Data, Effect, Either } from "effect"
import { join, resolve } from "node:path"
import { cp, lstat, realpath, rename, rm } from "node:fs/promises"
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
import {
	VersionControlService,
	type VersionControlBackend,
} from "./VersionControlService"

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

const portableRemote = (path: string, backend?: VersionControlBackend) =>
	Effect.gen(function* () {
		const backendRemote = backend
			? yield* backend.remoteUrl(path, "origin")
			: null
		const remote = backendRemote ?? (yield* inspectRemote(path))
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

const removalBlockers = (
	repository: RepositoryInfo,
	startPath: string,
	backend: VersionControlBackend,
) =>
	Effect.gen(function* () {
		const fs = yield* FileSystemService
		const graph = yield* GraphService
		const report = yield* graph.get({ cwd: startPath, backend })
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
			const repositoryTarget = yield* fs.realPath(repository.path)
			const linkedTarget =
				repository.kind === "symlink"
					? yield* fs.realPath(repository.path)
					: null
			for (const workspace of yield* backend.listWorkspaces(repository.path)) {
				if (
					workspace.path !== repositoryTarget &&
					workspace.path !== linkedTarget
				)
					worktrees.push(workspace.path)
			}
		}
		return { references, worktrees }
	})

const assertRemovable = (
	repository: RepositoryInfo,
	startPath: string,
	backend: VersionControlBackend,
) =>
	Effect.gen(function* () {
		const blockers = yield* removalBlockers(repository, startPath, backend)
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
	check: Effect.Effect<void, unknown, any>,
): TransactionStep => ({
	label,
	preflight: () =>
		Effect.runPromise(check as Effect.Effect<void, unknown, never>),
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

const runGit = (
	fs: Effect.Effect.Success<typeof FileSystemService>,
	args: readonly string[],
	label: string,
) =>
	Effect.runPromise(
		fs
			.runCommand(["git", ...args], { captureOutput: true })
			.pipe(
				Effect.flatMap((result) =>
					result.exitCode === 0
						? Effect.void
						: Effect.fail(
								new Error(
									`${label}: ${result.stderr.trim() || result.stdout.trim()}`,
								),
							),
				),
			) as Effect.Effect<void, unknown, never>,
	)

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
					const versionControl = yield* VersionControlService
					const validAlias = yield* validateAlias(alias)
					const state = yield* configState(startPath)
					const backend = yield* versionControl.forWorkbase(state.root)
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
						: yield* portableRemote(cloneSource, backend)
					const staging = join(
						state.root,
						"repos",
						`.agency-clone-${validAlias}-${process.pid}-${Date.now()}`,
					)
					yield* fs.createDirectory(join(state.root, "repos"))
					yield* backend.cloneRepository(cloneSource, staging).pipe(
						Effect.catchAll((cause) =>
							fs.deleteDirectory(staging).pipe(
								Effect.ignore,
								Effect.zipRight(
									Effect.fail(
										new RepositoryError({
											message: `Failed to clone repository '${remote}': ${cause instanceof Error ? cause.message : String(cause)}`,
											cause,
										}),
									),
								),
							),
						),
					)
					if (declaredRemote !== remote) {
						yield* backend.setRemoteUrl(staging, "origin", declaredRemote)
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
					const versionControl = yield* VersionControlService
					const graph = yield* GraphService
					const workbase = yield* WorkbaseService
					const validAlias = yield* validateAlias(alias)
					const state = yield* configState(startPath)
					const backend = yield* versionControl.forWorkbase(state.root)
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
					const inspection = yield* backend.inspectRepository(resolvedTarget)
					if (!inspection && backend.kind === "git") {
						return yield* new RepositoryError({
							message: `Path is not a ${backend.kind} repository: ${resolvedTarget}`,
						})
					}
					yield* backend.initializeRepository(resolvedTarget)
					if (!(yield* backend.inspectRepository(resolvedTarget))) {
						return yield* new RepositoryError({
							message: `Path is not a ${backend.kind} repository: ${resolvedTarget}`,
						})
					}
					const declaredRemote =
						state.config.repositories?.[validAlias]?.remote ??
						(yield* portableRemote(resolvedTarget, backend))
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
								assertRemovable(localCurrent, state.root, backend).pipe(
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

			materialize: (alias: string, startPath: string = process.cwd()) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const versionControl = yield* VersionControlService
					const repository = yield* find(alias, startPath)
					if (repository.kind !== "symlink" || !repository.target) {
						return yield* new RepositoryError({
							message: `Repository alias '${alias}' is not linked`,
						})
					}
					if (repository.states.includes("invalid")) {
						return yield* new RepositoryError({
							message: `Repository alias '${alias}' has an invalid linked repository`,
						})
					}
					if (repository.states.includes("remote-drifted")) {
						return yield* new RepositoryError({
							message: `Repository alias '${alias}' cannot be materialized while its origin differs from the portable declaration`,
						})
					}
					if (!repository.declaredRemote) {
						return yield* new RepositoryError({
							message: `Repository alias '${alias}' has no portable remote declaration`,
						})
					}

					const state = yield* configState(startPath)
					const backend = yield* versionControl.forWorkbase(state.root)
					if (backend.kind !== "git") {
						return yield* new RepositoryError({
							message: `Repository alias materialization is only supported for Git workbases`,
						})
					}

					const source = yield* fs.realPath(repository.path)
					const registered = yield* backend.listWorkspaces(repository.path)
					const registeredPaths = registered
						.map((workspace) => workspace.path)
						.sort()
					const worktrees: (typeof registered)[number][] = []
					for (const workspace of registered) {
						if (!(yield* fs.isDirectory(workspace.path))) {
							return yield* new RepositoryError({
								message: `Repository alias '${alias}' has a stale worktree registration: ${workspace.path}`,
							})
						}
						if (
							(yield* fs.inspectFile(join(workspace.path, ".git"))).kind ===
							"file"
						)
							worktrees.push(workspace)
					}

					const commonDirectory = yield* fs
						.runCommand(
							[
								"git",
								"-C",
								source,
								"rev-parse",
								"--path-format=absolute",
								"--git-common-dir",
							],
							{ captureOutput: true },
						)
						.pipe(
							Effect.flatMap((result) =>
								result.exitCode === 0
									? Effect.succeed(result.stdout.trim())
									: Effect.fail(
											new RepositoryError({
												message: `Failed to locate Git metadata for repository alias '${alias}'`,
											}),
										),
							),
						)
					const sourceWorktrees = join(commonDirectory, "worktrees")
					const hasWorktreeMetadata = yield* fs.isDirectory(sourceWorktrees)
					if (worktrees.length > 0 && !hasWorktreeMetadata) {
						return yield* new RepositoryError({
							message: `Repository alias '${alias}' is missing Git metadata for its registered worktrees`,
						})
					}

					const suffix = `${process.pid}-${Date.now()}`
					const staging = join(
						state.root,
						"repos",
						`.agency-materialize-${repository.alias}-${suffix}`,
					)
					const aliasBackup = join(
						state.root,
						"repos",
						`.agency-linked-${repository.alias}-${suffix}`,
					)
					const metadataBackup = `${sourceWorktrees}.agency-materialize-${suffix}`
					yield* fs.createDirectory(join(state.root, "repos"))
					yield* backend.cloneRepository(source, staging).pipe(
						Effect.catchAll((cause) =>
							fs.deleteDirectory(staging).pipe(
								Effect.ignore,
								Effect.zipRight(
									Effect.fail(
										new RepositoryError({
											message: `Failed to materialize repository '${alias}': ${cause instanceof Error ? cause.message : String(cause)}`,
											cause,
										}),
									),
								),
							),
						),
					)
					yield* backend
						.setRemoteUrl(staging, "origin", repository.declaredRemote)
						.pipe(
							Effect.catchAll((cause) =>
								fs
									.deleteDirectory(staging)
									.pipe(Effect.ignore, Effect.zipRight(Effect.fail(cause))),
							),
						)
					for (const workspace of worktrees) {
						if (!workspace.commit) continue
						const object = yield* fs.runCommand(
							[
								"git",
								"--git-dir",
								staging,
								"cat-file",
								"-e",
								`${workspace.commit}^{commit}`,
							],
							{ captureOutput: true },
						)
						if (object.exitCode !== 0) {
							yield* fs.deleteDirectory(staging).pipe(Effect.ignore)
							return yield* new RepositoryError({
								message: `Registered worktree commit '${workspace.commit}' is missing from the materialized repository`,
							})
						}
					}

					let metadataMoved = false
					let aliasMoved = false
					let cloneInstalled = false
					const workspacePaths = worktrees.map((workspace) => workspace.path)
					const repair = (gitDirectory: string) =>
						workspacePaths.length === 0
							? Promise.resolve()
							: runGit(
									fs,
									[
										"--git-dir",
										gitDirectory,
										"worktree",
										"repair",
										...workspacePaths,
									],
									"Failed to repair Git worktrees",
								)
					const rollbackMigration = async () => {
						const errors: unknown[] = []
						if (metadataMoved) {
							try {
								await rename(metadataBackup, sourceWorktrees)
								metadataMoved = false
								await repair(commonDirectory)
							} catch (error) {
								errors.push(error)
							}
						}
						if (cloneInstalled) {
							try {
								await rename(repository.path, staging)
								cloneInstalled = false
							} catch (error) {
								errors.push(error)
							}
						}
						if (aliasMoved) {
							try {
								await rename(aliasBackup, repository.path)
								aliasMoved = false
							} catch (error) {
								errors.push(error)
							}
						}
						if (errors.length > 0) throw new AggregateError(errors)
					}
					const migration: TransactionStep = {
						label: `materialize linked repository ${repository.alias}`,
						preflight: async () => {
							const stats = await lstat(repository.path)
							if (
								!stats.isSymbolicLink() ||
								(await realpath(repository.path)) !== source
							)
								throw new Error(
									`Repository alias '${repository.alias}' changed during materialization`,
								)
							const current = await Effect.runPromise(
								backend
									.listWorkspaces(repository.path)
									.pipe(
										Effect.provideService(FileSystemService, fs),
									) as unknown as Effect.Effect<
									readonly { readonly path: string }[],
									unknown,
									never
								>,
							)
							const currentPaths = current
								.map((workspace) => workspace.path)
								.sort()
							if (
								JSON.stringify(currentPaths) !== JSON.stringify(registeredPaths)
							)
								throw new Error(
									`Git worktree registrations changed during materialization`,
								)
						},
						apply: async () => {
							try {
								if (hasWorktreeMetadata) {
									await rename(sourceWorktrees, metadataBackup)
									metadataMoved = true
									await cp(metadataBackup, join(staging, "worktrees"), {
										recursive: true,
									})
								}
								await rename(repository.path, aliasBackup)
								aliasMoved = true
								await rename(staging, repository.path)
								cloneInstalled = true
								await repair(repository.path)
							} catch (cause) {
								try {
									await rollbackMigration()
								} catch (rollbackCause) {
									throw new Error(
										`Repository materialization failed and rollback requires manual recovery: restore ${aliasBackup} to ${repository.path} and ${metadataBackup} to ${sourceWorktrees}`,
										{ cause: new AggregateError([cause, rollbackCause]) },
									)
								}
								throw cause
							}
						},
						rollback: rollbackMigration,
						finalize: async () => {
							await rm(aliasBackup, { recursive: true, force: true })
							await rm(metadataBackup, { recursive: true, force: true })
						},
						manualRecovery: `Restore ${aliasBackup} to ${repository.path} and ${metadataBackup} to ${sourceWorktrees}`,
					}

					yield* runLifecycleTransaction({
						root: state.root,
						preconditions: [{ path: state.path, revision: state.revision }],
						steps: [migration],
					}).pipe(
						Effect.mapError(
							(cause) => new RepositoryError({ message: cause.message, cause }),
						),
						Effect.ensuring(fs.deleteDirectory(staging).pipe(Effect.ignore)),
					)
					return yield* find(alias, startPath)
				}),

			list: (startPath: string = process.cwd()) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const { root, config } = yield* WorkbaseService.pipe(
						Effect.flatMap((service) => service.loadConfig(startPath)),
					)
					const versionControl = yield* VersionControlService
					const backend = yield* versionControl.forWorkbase(root)
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
					return yield* Effect.forEach(
						[...aliases].sort(),
						(alias) =>
							Effect.gen(function* () {
								const path = join(reposPath, alias)
								const entry = local.get(alias)
								const declaredRemote =
									config.repositories?.[alias]?.remote ?? null
								if (!entry) {
									return {
										alias,
										path,
										kind: null,
										remote: null,
										declaredRemote,
										target: null,
										states: ["declared", "missing"] as RepositoryState[],
									} satisfies RepositoryInfo
								}
								if (!entry.isDirectory && !entry.isSymlink) {
									return {
										alias,
										path,
										kind: null,
										remote: null,
										declaredRemote,
										target: null,
										states: [
											...(declaredRemote ? (["declared"] as const) : []),
											"invalid",
										] as RepositoryState[],
									} satisfies RepositoryInfo
								}
								const target = entry.isSymlink
									? yield* fs.readSymlinkTarget(path)
									: null
								const inspection = yield* backend.inspectRepository(path)
								const remote = inspection?.remote ?? null
								const states: RepositoryState[] = []
								if (declaredRemote) states.push("declared")
								states.push(entry.isSymlink ? "linked" : "materialized")
								if (!inspection) states.push("invalid")
								if (declaredRemote && remote !== declaredRemote)
									states.push("remote-drifted")
								return {
									alias,
									path,
									kind: entry.isSymlink
										? "symlink"
										: (inspection?.kind ?? "repository"),
									remote,
									declaredRemote,
									target,
									states,
								} satisfies RepositoryInfo
							}),
						{ concurrency: 8 },
					)
				}),

			show: (alias: string, startPath: string = process.cwd()) =>
				find(alias, startPath),

			fetch: (alias: string, startPath: string = process.cwd()) =>
				Effect.gen(function* () {
					const versionControl = yield* VersionControlService
					const repository = yield* find(alias, startPath).pipe(
						Effect.flatMap(requireMaterialized),
					)
					const backend = yield* versionControl.forWorkbase(startPath)
					yield* backend.fetch(repository.path, undefined, undefined)
					return repository
				}),

			remove: (alias: string, startPath: string = process.cwd()) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const graph = yield* GraphService
					const workbase = yield* WorkbaseService
					const versionControl = yield* VersionControlService
					const repository = yield* find(alias, startPath)
					const state = yield* configState(startPath)
					const backend = yield* versionControl.forWorkbase(state.root)
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
						assertRemovable(repository, startPath, backend).pipe(
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
					const versionControl = yield* VersionControlService
					const repository = yield* find(alias, startPath)
					if (repository.kind !== "symlink") {
						return yield* new RepositoryError({
							message: `Repository alias '${alias}' is not a link; use 'agency repo remove ${alias}'`,
						})
					}
					const state = yield* configState(startPath)
					const backend = yield* versionControl.forWorkbase(state.root)
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
								assertRemovable(repository, startPath, backend).pipe(
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
					const versionControl = yield* VersionControlService
					const repository = yield* find(alias, startPath)
					const validNewAlias = yield* validateAlias(newAlias)
					const state = yield* configState(startPath)
					const backend = yield* versionControl.forWorkbase(state.root)
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
						assertRemovable(repository, startPath, backend).pipe(
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
					const versionControl = yield* VersionControlService
					const repository = yield* find(alias, startPath)
					if (remote === undefined) return repository
					const portable = yield* validateRemote(remote)
					const state = yield* configState(startPath)
					const backend = yield* versionControl.forWorkbase(state.root)
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
								backend
									.setRemoteUrl(repository.path, "origin", value)
									.pipe(
										Effect.provideService(FileSystemService, fs),
									) as Effect.Effect<void, unknown, never>,
							)
						steps.push({
							label: `update origin for repos/${repository.alias}`,
							preflight: async () => {
								const stats = await lstat(repository.path)
								if (stats.isSymbolicLink()) {
									throw new Error(
										`Repository alias '${repository.alias}' changed to a linked checkout; retry the remote update`,
									)
								}
								const currentRemote = await Effect.runPromise(
									backend
										.remoteUrl(repository.path, "origin")
										.pipe(Effect.provideService(FileSystemService, fs)),
								)
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
						issues.push("Path is not a valid repository")
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
				options: {
					readonly cwd?: string
					readonly apply?: boolean
					readonly aliases?: readonly string[]
				} = {},
			) =>
				Effect.gen(function* () {
					const service = yield* RepositoryService
					const fs = yield* FileSystemService
					const versionControl = yield* VersionControlService
					const state = yield* configState(options.cwd ?? process.cwd())
					const backend = yield* versionControl.forWorkbase(state.root)
					const requestedAliases = options.aliases
						? new Set(options.aliases)
						: null
					const repositories = (yield* service.list(state.root)).filter(
						(repository) =>
							!requestedAliases || requestedAliases.has(repository.alias),
					)
					const planned: Omit<RepositorySetupAction, "status">[] = []
					const unresolved: RepositorySetupIssue[] = []

					for (const repository of repositories) {
						if (repository.states.includes("invalid")) {
							unresolved.push({
								alias: repository.alias,
								state: "invalid",
								message: `Local path for '${repository.alias}' is not a valid repository`,
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
							const cloned = yield* backend
								.cloneRepository(action.remote, from)
								.pipe(Effect.either)
							if (Either.isLeft(cloned)) {
								for (const item of staging)
									yield* fs.deleteDirectory(item.from).pipe(Effect.ignore)
								return yield* new RepositoryError({
									message: `Failed to materialize repository '${action.alias}': ${cloned.left instanceof Error ? cloned.left.message : String(cloned.left)}`,
									cause: cloned.left,
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
								? (yield* service.list(state.root)).filter(
										(repository) =>
											!requestedAliases ||
											requestedAliases.has(repository.alias),
									)
								: repositories,
					} satisfies RepositorySetupResult
				}),
		}),
	},
) {}
