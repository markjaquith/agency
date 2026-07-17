import { Schema, TreeFormatter } from "@effect/schema"
import { Data, Effect, Either } from "effect"
import { join, resolve } from "node:path"
import { FileSystemService } from "./FileSystemService"
import { GraphService } from "./GraphService"
import { WorkbaseService } from "./WorkbaseService"
import { RepositoryAlias } from "../workbase/schemas"

class RepositoryError extends Data.TaggedError("RepositoryError")<{
	readonly message: string
	readonly cause?: unknown
}> {}

interface RepositoryInfo {
	readonly alias: string
	readonly path: string
	readonly kind: "bare" | "repository" | "symlink"
	readonly remote: string | null
	readonly target: string | null
}

interface RepositoryVerification extends RepositoryInfo {
	readonly valid: boolean
	readonly issues: readonly string[]
}

const validateAlias = (alias: string) => {
	const result = Schema.decodeUnknownEither(RepositoryAlias)(alias)
	return Either.isLeft(result)
		? Effect.fail(
				new RepositoryError({
					message: `Invalid repository alias '${alias}': ${TreeFormatter.formatErrorSync(result.left)}`,
				}),
			)
		: Effect.succeed(result.right)
}

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
		if (repository.kind !== "symlink") {
			const result = yield* fs.runCommand(
				["git", "-C", repository.path, "worktree", "list", "--porcelain"],
				{ captureOutput: true },
			)
			if (result.exitCode === 0) {
				for (const block of result.stdout.trim().split(/\n\n+/)) {
					if (!block || /(^|\n)bare(\n|$)/.test(block)) continue
					const path = block.match(/^worktree (.+)$/m)?.[1]
					if (path) worktrees.push(path)
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

export class RepositoryService extends Effect.Service<RepositoryService>()(
	"RepositoryService",
	{
		sync: () => ({
			add: (alias: string, remote: string, startPath: string = process.cwd()) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const workbase = yield* WorkbaseService
					const validAlias = yield* validateAlias(alias)
					const root = yield* workbase.discover(startPath)
					const reposPath = join(root, "repos")
					const destination = join(reposPath, validAlias)

					if (!remote.trim()) {
						return yield* new RepositoryError({
							message: "Repository remote is required",
						})
					}
					if (yield* fs.exists(destination)) {
						return yield* new RepositoryError({
							message: `Repository alias '${validAlias}' already exists`,
						})
					}

					yield* fs.createDirectory(reposPath)
					const result = yield* fs.runCommand(
						["git", "clone", "--bare", remote, destination],
						{ captureOutput: true },
					)
					if (result.exitCode !== 0) {
						yield* fs.deleteDirectory(destination).pipe(Effect.ignore)
						return yield* new RepositoryError({
							message: `Failed to clone repository '${remote}': ${result.stderr.trim()}`,
						})
					}

					return destination
				}),

			link: (
				alias: string,
				target: string,
				startPath: string = process.cwd(),
			) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const workbase = yield* WorkbaseService
					const validAlias = yield* validateAlias(alias)
					const root = yield* workbase.discover(startPath)
					const reposPath = join(root, "repos")
					const destination = join(reposPath, validAlias)
					const resolvedTarget = resolve(startPath, target)

					if (yield* fs.exists(destination)) {
						return yield* new RepositoryError({
							message: `Repository alias '${validAlias}' already exists`,
						})
					}
					if (!(yield* fs.isDirectory(resolvedTarget))) {
						return yield* new RepositoryError({
							message: `Repository path does not exist: ${resolvedTarget}`,
						})
					}

					const result = yield* fs.runCommand(
						["git", "-C", resolvedTarget, "rev-parse", "--git-dir"],
						{ captureOutput: true },
					)
					if (result.exitCode !== 0) {
						return yield* new RepositoryError({
							message: `Path is not a Git repository: ${resolvedTarget}`,
						})
					}

					yield* fs.createDirectory(reposPath)
					yield* fs.createSymlink(resolvedTarget, destination)
					return destination
				}),

			list: (startPath: string = process.cwd()) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const workbase = yield* WorkbaseService
					const root = yield* workbase.discover(startPath)
					const reposPath = join(root, "repos")

					if (!(yield* fs.isDirectory(reposPath))) {
						return [] as RepositoryInfo[]
					}

					const entries = (yield* fs.readDirectory(reposPath))
						.filter((entry) => entry.isDirectory || entry.isSymlink)
						.sort((a, b) => a.name.localeCompare(b.name))
					const repositories: RepositoryInfo[] = []

					for (const entry of entries) {
						const path = join(reposPath, entry.name)
						const target = entry.isSymlink
							? yield* fs.readSymlinkTarget(path)
							: null
						const bareResult = yield* fs.runCommand(
							["git", "-C", path, "rev-parse", "--is-bare-repository"],
							{ captureOutput: true },
						)
						const remoteResult = yield* fs.runCommand(
							["git", "-C", path, "remote", "get-url", "origin"],
							{ captureOutput: true },
						)

						repositories.push({
							alias: entry.name,
							path,
							kind: entry.isSymlink
								? "symlink"
								: bareResult.stdout.trim() === "true"
									? "bare"
									: "repository",
							remote:
								remoteResult.exitCode === 0 ? remoteResult.stdout.trim() : null,
							target,
						})
					}

					return repositories
				}),

			show: (alias: string, startPath: string = process.cwd()) =>
				find(alias, startPath),

			fetch: (alias: string, startPath: string = process.cwd()) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const repository = yield* find(alias, startPath)
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
					const repository = yield* find(alias, startPath)
					yield* assertRemovable(repository, startPath)
					yield* fs.deleteDirectory(repository.path)
					return repository
				}),

			unlink: (alias: string, startPath: string = process.cwd()) =>
				Effect.gen(function* () {
					const service = yield* RepositoryService
					const repository = yield* find(alias, startPath)
					if (repository.kind !== "symlink") {
						return yield* new RepositoryError({
							message: `Repository alias '${alias}' is not a link; use 'agency repo remove ${alias}'`,
						})
					}
					return yield* service.remove(alias, startPath)
				}),

			rename: (
				alias: string,
				newAlias: string,
				startPath: string = process.cwd(),
			) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const workbase = yield* WorkbaseService
					const repository = yield* find(alias, startPath)
					const validNewAlias = yield* validateAlias(newAlias)
					const root = yield* workbase.discover(startPath)
					const destination = join(root, "repos", validNewAlias)
					if (yield* fs.exists(destination)) {
						return yield* new RepositoryError({
							message: `Repository alias '${validNewAlias}' already exists`,
						})
					}
					yield* assertRemovable(repository, startPath)
					yield* fs.moveDirectory(repository.path, destination)
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
					if (!remote.trim()) {
						return yield* new RepositoryError({
							message: "Repository remote is required",
						})
					}
					const hasOrigin = repository.remote !== null
					const result = yield* fs.runCommand(
						[
							"git",
							"-C",
							repository.path,
							"remote",
							hasOrigin ? "set-url" : "add",
							"origin",
							remote,
						],
						{ captureOutput: true },
					)
					if (result.exitCode !== 0) {
						return yield* new RepositoryError({
							message: `Failed to update remote for repository '${alias}': ${result.stderr.trim()}`,
						})
					}
					return yield* find(alias, startPath)
				}),

			verify: (alias: string, startPath: string = process.cwd()) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const repository = yield* find(alias, startPath)
					const issues: string[] = []
					const git = yield* fs.runCommand(
						["git", "-C", repository.path, "rev-parse", "--git-dir"],
						{ captureOutput: true },
					)
					if (git.exitCode !== 0) issues.push("Path is not a Git repository")
					if (repository.remote === null)
						issues.push("Origin remote is not configured")
					return {
						...repository,
						valid: issues.length === 0,
						issues,
					} satisfies RepositoryVerification
				}),
		}),
	},
) {}
