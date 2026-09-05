import { Schema, TreeFormatter } from "@effect/schema"
import { Cause, Data, Effect, Either, Exit } from "effect"
import { join, resolve } from "node:path"
import { cp, lstat, realpath, rename, rm } from "node:fs/promises"
import { FileSystemService } from "./FileSystemService"
import { GraphService } from "./GraphService"
import { WorkbaseService } from "./WorkbaseService"
import {
	directoryMoveStep,
	documentWriteStep,
	runLifecycleTransaction,
	transactionEffect,
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
	type RegisteredWorkspace,
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

const inspectRepository = (
	alias: string,
	state: Effect.Effect.Success<ReturnType<typeof configState>>,
	backend: VersionControlBackend,
) =>
	Effect.gen(function* () {
		const fs = yield* FileSystemService
		const path = join(state.root, "repos", alias)
		const declaredRemote = state.config.repositories?.[alias]?.remote ?? null
		const entry = yield* fs.inspectFile(path)
		if (entry.kind === "missing") {
			if (declaredRemote) {
				return {
					alias,
					path,
					kind: null,
					remote: null,
					declaredRemote,
					target: null,
					states: ["declared", "missing"],
				} as RepositoryInfo
			}
			return yield* new RepositoryError({
				message: `Unknown repository alias '${alias}'`,
			})
		}
		const isSymlink = entry.kind === "symlink"
		if (!isSymlink && !(yield* fs.isDirectory(path))) {
			return {
				alias,
				path,
				kind: null,
				remote: null,
				declaredRemote,
				target: null,
				states: [...(declaredRemote ? (["declared"] as const) : []), "invalid"],
			} as RepositoryInfo
		}
		const target = isSymlink ? yield* fs.readSymlinkTarget(path) : null
		const inspection = yield* backend.inspectRepository(path)
		const remote = inspection?.remote ?? null
		const states: RepositoryState[] = []
		if (declaredRemote) states.push("declared")
		states.push(isSymlink ? "linked" : "materialized")
		if (!inspection) states.push("invalid")
		if (declaredRemote && remote !== declaredRemote)
			states.push("remote-drifted")
		return {
			alias,
			path,
			kind: isSymlink ? "symlink" : (inspection?.kind ?? "repository"),
			remote,
			declaredRemote,
			target,
			states,
		} as RepositoryInfo
	})

const find = (alias: string, startPath: string) =>
	Effect.gen(function* () {
		const versionControl = yield* VersionControlService
		const validAlias = yield* validateAlias(alias)
		const state = yield* configState(startPath)
		const backend = yield* versionControl.forWorkbase(state.root)
		return yield* inspectRepository(validAlias, state, backend)
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

const effectPreflightStep = <R>(
	label: string,
	check: Effect.Effect<void, unknown, R>,
): TransactionStep<R> => ({
	label,
	preflight: check,
	apply: Effect.void,
})

const deleteAfterMoveStep = (
	root: string,
	from: string,
	to: string,
): TransactionStep => ({
	...directoryMoveStep(root, from, to),
	finalize: transactionEffect(() => rm(to, { recursive: true, force: true })),
	manualRecovery: `Remove ${to} or move it back to ${from}`,
})

const replaceWithMoveStep = (
	current: string,
	replacement: string,
	backup: string,
): TransactionStep => ({
	label: `replace ${current} with ${replacement}`,
	preflight: transactionEffect(async () => {
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
	}),
	apply: transactionEffect(async () => {
		await rename(current, backup)
		try {
			await rename(replacement, current)
		} catch (cause) {
			await rename(backup, current)
			throw cause
		}
	}),
	rollback: transactionEffect(async () => {
		await rename(current, replacement)
		await rename(backup, current)
	}),
	finalize: transactionEffect(() =>
		rm(backup, { recursive: true, force: true }),
	),
	manualRecovery: `Restore ${backup} to ${current}`,
})

const runGit = (
	fs: Effect.Effect.Success<typeof FileSystemService>,
	args: readonly string[],
	label: string,
) =>
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
		)

const runTransaction = (
	state: Effect.Effect.Success<ReturnType<typeof configState>>,
	config: WorkbaseConfig,
	steps: readonly TransactionStep<any>[],
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
			(cause) =>
				new RepositoryError({
					message: cause instanceof Error ? cause.message : String(cause),
					cause,
				}),
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
					const current =
						state.config.repositories?.[validAlias] ||
						(yield* fs.exists(destination))
							? yield* inspectRepository(validAlias, state, backend)
							: undefined
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
					if (!inspection) {
						return yield* new RepositoryError({
							message: `Path is not a Git repository: ${resolvedTarget}`,
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
					const validAlias = yield* validateAlias(alias)
					const state = yield* configState(startPath)
					const backend = yield* versionControl.forWorkbase(state.root)
					const repository = yield* inspectRepository(
						validAlias,
						state,
						backend,
					)
					if (repository.kind !== "symlink" || !repository.target) {
						return yield* new RepositoryError({
							message: `Repository alias '${validAlias}' is not linked`,
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

					const source = yield* fs.realPath(repository.path)
					const registered = yield* backend.listWorkspaces(repository.path)
					const registeredState = registered
						.map(({ path, commit, branch }) => ({ path, commit, branch }))
						.sort((left, right) => left.path.localeCompare(right.path))
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
					const reviewRefs = yield* fs.runCommand(
						[
							"git",
							"-C",
							source,
							"for-each-ref",
							"--format=%(refname)",
							"refs/agency/reviews/",
						],
						{ captureOutput: true },
					)
					if (reviewRefs.exitCode !== 0) {
						yield* fs.deleteDirectory(staging).pipe(Effect.ignore)
						return yield* new RepositoryError({
							message: `Failed to enumerate Agency review refs while materializing repository '${alias}'`,
						})
					}
					const preservedReviewRefs = reviewRefs.stdout
						.split("\n")
						.map((ref) => ref.trim())
						.filter(Boolean)
					const worktreeCommits = [
						...new Set(
							worktrees
								.map((workspace) => workspace.commit)
								.filter((commit): commit is string => commit !== null),
						),
					]
					const temporaryRefs = worktreeCommits.map(
						(_, index) =>
							`refs/agency/materialize/${suffix}/${String(index).padStart(4, "0")}`,
					)
					const preservationRefspecs = [
						...preservedReviewRefs.map((ref) => `+${ref}:${ref}`),
						...worktreeCommits.map(
							(commit, index) => `+${commit}:${temporaryRefs[index]}`,
						),
					]
					if (preservationRefspecs.length > 0) {
						const preserved = yield* fs.runCommand(
							[
								"git",
								"--git-dir",
								staging,
								"fetch",
								"--no-tags",
								"--no-write-fetch-head",
								source,
								...preservationRefspecs,
							],
							{ captureOutput: true },
						)
						if (preserved.exitCode !== 0) {
							yield* fs.deleteDirectory(staging).pipe(Effect.ignore)
							return yield* new RepositoryError({
								message: `Failed to preserve Agency refs and registered worktree commits while materializing repository '${alias}': ${preserved.stderr.trim()}`,
							})
						}
						for (const ref of temporaryRefs) {
							const removed = yield* fs.runCommand(
								["git", "--git-dir", staging, "update-ref", "-d", ref],
								{ captureOutput: true },
							)
							if (removed.exitCode !== 0) {
								yield* fs.deleteDirectory(staging).pipe(Effect.ignore)
								return yield* new RepositoryError({
									message: `Failed to remove temporary materialization ref '${ref}' for repository '${alias}': ${removed.stderr.trim()}`,
								})
							}
						}
					}
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
							? Effect.void
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
					const rollbackMigration = Effect.gen(function* () {
						const errors: unknown[] = []
						const attempt = (effect: Effect.Effect<void, unknown, any>) =>
							effect.pipe(
								Effect.exit,
								Effect.tap((exit) => {
									if (Exit.isFailure(exit))
										errors.push(Cause.squash(exit.cause))
								}),
							)
						if (metadataMoved) {
							yield* attempt(
								transactionEffect(async () => {
									await rename(metadataBackup, sourceWorktrees)
									metadataMoved = false
								}).pipe(Effect.zipRight(repair(commonDirectory))),
							)
						}
						if (cloneInstalled) {
							yield* attempt(
								transactionEffect(async () => {
									await rename(repository.path, staging)
									cloneInstalled = false
								}),
							)
						}
						if (aliasMoved) {
							yield* attempt(
								transactionEffect(async () => {
									await rename(aliasBackup, repository.path)
									aliasMoved = false
								}),
							)
						}
						if (errors.length > 0)
							return yield* Effect.fail(new AggregateError(errors))
					})
					const migration: TransactionStep<any> = {
						label: `materialize linked repository ${repository.alias}`,
						preflight: Effect.gen(function* () {
							const stats = yield* transactionEffect(() =>
								lstat(repository.path),
							)
							if (
								!stats.isSymbolicLink() ||
								(yield* transactionEffect(() => realpath(repository.path))) !==
									source
							)
								return yield* Effect.fail(
									new Error(
										`Repository alias '${repository.alias}' changed during materialization`,
									),
								)
							const current = yield* backend
								.listWorkspaces(repository.path)
								.pipe(
									Effect.provideService(FileSystemService, fs),
								) as Effect.Effect<readonly RegisteredWorkspace[], unknown, any>
							const currentState = current
								.map(({ path, commit, branch }) => ({ path, commit, branch }))
								.sort((left, right) => left.path.localeCompare(right.path))
							if (
								JSON.stringify(currentState) !== JSON.stringify(registeredState)
							)
								return yield* Effect.fail(
									new Error(
										`Git worktree registrations changed during materialization`,
									),
								)
						}),
						apply: Effect.gen(function* () {
							if (hasWorktreeMetadata) {
								yield* transactionEffect(async () => {
									await rename(sourceWorktrees, metadataBackup)
									metadataMoved = true
								})
								yield* transactionEffect(() =>
									cp(metadataBackup, join(staging, "worktrees"), {
										recursive: true,
									}),
								)
							}
							yield* transactionEffect(async () => {
								await rename(repository.path, aliasBackup)
								aliasMoved = true
							})
							yield* transactionEffect(async () => {
								await rename(staging, repository.path)
								cloneInstalled = true
							})
							yield* repair(repository.path)
						}).pipe(
							Effect.catchAllCause((cause) =>
								rollbackMigration.pipe(
									Effect.catchAllCause((rollbackCause) =>
										Effect.fail(
											new Error(
												`Repository materialization failed and rollback requires manual recovery: restore ${aliasBackup} to ${repository.path} and ${metadataBackup} to ${sourceWorktrees}`,
												{
													cause: new AggregateError([
														Cause.squash(cause),
														Cause.squash(rollbackCause),
													]),
												},
											),
										),
									),
									Effect.zipRight(Effect.failCause(cause)),
								),
							),
						),
						rollback: rollbackMigration,
						finalize: transactionEffect(async () => {
							await rm(aliasBackup, { recursive: true, force: true })
							await rm(metadataBackup, { recursive: true, force: true })
						}),
						manualRecovery: `Restore ${aliasBackup} to ${repository.path} and ${metadataBackup} to ${sourceWorktrees}`,
					}

					yield* runLifecycleTransaction({
						root: state.root,
						preconditions: [{ path: state.path, revision: state.revision }],
						steps: [migration],
					}).pipe(
						Effect.mapError(
							(cause) =>
								new RepositoryError({
									message:
										cause instanceof Error ? cause.message : String(cause),
									cause,
								}),
						),
						Effect.ensuring(fs.deleteDirectory(staging).pipe(Effect.ignore)),
					)
					return yield* find(alias, startPath)
				}),

			list: (startPath: string = process.cwd()) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const versionControl = yield* VersionControlService
					const state = yield* configState(startPath)
					const backend = yield* versionControl.forWorkbase(state.root)
					const reposPath = join(state.root, "repos")
					const entries = (yield* fs.isDirectory(reposPath))
						? (yield* fs.readDirectory(reposPath)).filter(
								(entry) => !entry.name.startsWith(".agency-"),
							)
						: []
					const aliases = new Set([
						...Object.keys(state.config.repositories ?? {}),
						...entries.map((entry) => entry.name),
					])
					return yield* Effect.forEach(
						[...aliases].sort(),
						(alias) => inspectRepository(alias, state, backend),
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
							(cause) =>
								new RepositoryError({
									message:
										cause instanceof Error ? cause.message : String(cause),
									cause,
								}),
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
					const steps: TransactionStep<any>[] = []
					if (
						repository.kind !== null &&
						repository.kind !== "symlink" &&
						!repository.states.includes("invalid")
					) {
						const previous = repository.remote
						const update = (value: string | null) =>
							backend
								.setRemoteUrl(repository.path, "origin", value)
								.pipe(Effect.provideService(FileSystemService, fs))
						steps.push({
							label: `update origin for repos/${repository.alias}`,
							preflight: Effect.gen(function* () {
								const stats = yield* Effect.tryPromise({
									try: () => lstat(repository.path),
									catch: (cause) => cause,
								})
								if (stats.isSymbolicLink()) {
									throw new Error(
										`Repository alias '${repository.alias}' changed to a linked checkout; retry the remote update`,
									)
								}
								const currentRemote = yield* backend
									.remoteUrl(repository.path, "origin")
									.pipe(Effect.provideService(FileSystemService, fs))
								if (currentRemote !== previous) {
									throw new Error(
										`Origin for repository '${repository.alias}' changed; retry the remote update`,
									)
								}
							}),
							apply: update(portable),
							rollback: update(previous),
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
